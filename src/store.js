// LanceDB wrapper. One table `chunks` keyed by deterministic id (path:start-end).
// Files tracked by mtime in `files` table for idempotent re-indexing.

import * as lancedb from "@lancedb/lancedb";
import * as arrow from "apache-arrow";
import { EMBEDDING_DIM } from "./embedder.js";

const CHUNKS_TABLE = "chunks";
const FILES_TABLE = "files";

const chunksSchema = new arrow.Schema([
  new arrow.Field("id", new arrow.Utf8(), false),
  new arrow.Field("path", new arrow.Utf8(), false),
  new arrow.Field("language", new arrow.Utf8(), false),
  new arrow.Field("start_line", new arrow.Int32(), false),
  new arrow.Field("end_line", new arrow.Int32(), false),
  new arrow.Field("content", new arrow.Utf8(), false),
  new arrow.Field(
    "vector",
    new arrow.FixedSizeList(EMBEDDING_DIM, new arrow.Field("item", new arrow.Float32(), true)),
    false,
  ),
]);

const filesSchema = new arrow.Schema([
  new arrow.Field("path", new arrow.Utf8(), false),
  new arrow.Field("mtime", new arrow.Float64(), false),
  new arrow.Field("chunk_count", new arrow.Int32(), false),
]);

export async function openStore(dataDir) {
  const db = await lancedb.connect(dataDir);
  return new Store(db);
}

function baseFilters({ language, pathGlob }) {
  const filters = [];
  if (language) filters.push(`language = '${language.replace(/'/g, "''")}'`);
  if (pathGlob) {
    const like = pathGlob.replace(/\*/g, "%");
    filters.push(`path LIKE '${like.replace(/'/g, "''")}'`);
  }
  return filters;
}

export class Store {
  constructor(db) {
    this.db = db;
    this.chunks = null;
    this.files = null;
  }

  async ensureTables() {
    if (this.chunks && this.files) return;
    const names = await this.db.tableNames();
    if (!names.includes(CHUNKS_TABLE)) {
      await this.db.createEmptyTable(CHUNKS_TABLE, chunksSchema);
    }
    if (!names.includes(FILES_TABLE)) {
      await this.db.createEmptyTable(FILES_TABLE, filesSchema);
    }
    this.chunks = await this.db.openTable(CHUNKS_TABLE);
    this.files = await this.db.openTable(FILES_TABLE);
  }

  async getFileMtimes() {
    await this.ensureTables();
    const rows = await this.files.query().toArray();
    const map = new Map();
    for (const r of rows) map.set(r.path, Number(r.mtime));
    return map;
  }

  async deleteFileChunks(filePath) {
    await this.ensureTables();
    const escaped = filePath.replace(/'/g, "''");
    await this.chunks.delete(`path = '${escaped}'`);
    await this.files.delete(`path = '${escaped}'`);
  }

  async upsertFile(filePath, mtime, chunks, vectors) {
    await this.ensureTables();
    if (chunks.length !== vectors.length) {
      throw new Error(`chunk/vector length mismatch: ${chunks.length} vs ${vectors.length}`);
    }
    await this.deleteFileChunks(filePath);
    if (chunks.length === 0) {
      // Still record the file mtime so we don't reprocess.
      await this.files.add([{ path: filePath, mtime: Math.floor(mtime), chunk_count: 0 }]);
      return;
    }
    const rows = chunks.map((c, i) => ({
      id: `${c.path}:${c.startLine}-${c.endLine}`,
      path: c.path,
      language: c.language,
      start_line: c.startLine,
      end_line: c.endLine,
      content: c.content,
      vector: Float32Array.from(vectors[i]),
    }));
    await this.chunks.add(rows);
    await this.files.add([{ path: filePath, mtime: Math.floor(mtime), chunk_count: chunks.length }]);
  }

  async search(queryVec, { k = 10, language, pathGlob } = {}) {
    await this.ensureTables();
    let q = this.chunks.search(Float32Array.from(queryVec)).limit(k);
    const filters = baseFilters({ language, pathGlob });
    if (filters.length) q = q.where(filters.join(" AND "));
    return q.toArray();
  }

  // Keyword search via SQL LIKE over chunk content. Returns candidates whose content
  // contains any of the query tokens. The caller (hybrid.js) does the actual scoring.
  // We cap to CANDIDATE_LIMIT because SQL LIKE can match a lot, and we only need a
  // reasonable candidate pool to feed into RRF.
  async keywordCandidates(tokens, { candidateLimit = 200, language, pathGlob } = {}) {
    await this.ensureTables();
    if (!tokens || tokens.length === 0) return [];
    // Dedupe + escape SQL single quotes. We don't escape %/_ — the whole query is
    // a positive match search, and '%' in a code query is vanishingly rare.
    const unique = [...new Set(tokens)].slice(0, 12); // cap to avoid absurdly long SQL
    const likeClauses = unique.map((t) => {
      const esc = t.replace(/'/g, "''");
      return `lower(content) LIKE '%${esc}%'`;
    });
    const filters = [`(${likeClauses.join(" OR ")})`];
    filters.push(...baseFilters({ language, pathGlob }));
    return this.chunks
      .query()
      .where(filters.join(" AND "))
      .limit(candidateLimit)
      .toArray();
  }

  async getChunk(id) {
    await this.ensureTables();
    const escaped = id.replace(/'/g, "''");
    const rows = await this.chunks.query().where(`id = '${escaped}'`).limit(1).toArray();
    return rows[0] || null;
  }

  async countChunks() {
    await this.ensureTables();
    return this.chunks.countRows();
  }

  async stats() {
    await this.ensureTables();
    const totalChunks = await this.chunks.countRows();
    const totalFiles = await this.files.countRows();
    const sample = await this.chunks.query().select(["language"]).limit(50000).toArray();
    const langs = {};
    for (const r of sample) langs[r.language] = (langs[r.language] || 0) + 1;
    return { totalChunks, totalFiles, languages: langs, sampleSize: sample.length };
  }
}
