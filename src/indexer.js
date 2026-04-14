#!/usr/bin/env node
// Repo indexer. Walks REPO_ROOT, chunks code-aware, embeds with jina, stores in LanceDB.
// Idempotent — only re-processes files whose mtime changed since last run.

import fs from "node:fs/promises";
import path from "node:path";
import { chunkFile, detectLanguage } from "./chunker.js";
import { embedBatch } from "./embedder.js";
import { openStore } from "./store.js";
import { resolveConfig } from "./config.js";
import { buildIgnore } from "./excludes.js";

const { repoRoot: REPO_ROOT, dataDir: DATA_DIR } = resolveConfig();

const FORCE_REINDEX = process.argv.includes("--reindex");
const STATS_ONLY = process.argv.includes("--stats");

async function main() {
  const store = await openStore(DATA_DIR);

  if (STATS_ONLY) {
    const s = await store.stats();
    console.log(JSON.stringify(s, null, 2));
    return;
  }

  console.log(`[code-rag] indexing ${REPO_ROOT}`);
  console.log(`[code-rag] data dir ${DATA_DIR}`);
  console.log(`[code-rag] reindex=${FORCE_REINDEX}`);

  const ig = buildIgnore({ repoRoot: REPO_ROOT, dataDir: DATA_DIR });

  const files = [];
  await walk(REPO_ROOT, REPO_ROOT, ig, files);
  console.log(`[code-rag] discovered ${files.length} candidate files`);

  const existingMtimes = FORCE_REINDEX ? new Map() : await store.getFileMtimes();

  let changed = 0, skipped = 0, processed = 0, totalChunks = 0;
  const queue = [];
  const QUEUE_BYTES = 200_000; // flush when buffered text exceeds ~200KB

  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) continue;
    const rel = path.relative(REPO_ROOT, file);
    const prevMtime = existingMtimes.get(rel);
    if (prevMtime !== undefined && prevMtime === Math.floor(stat.mtimeMs)) {
      skipped++;
      continue;
    }
    changed++;
    let source;
    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      // Probably binary or unreadable — skip
      continue;
    }
    const chunks = chunkFile(rel, source);
    if (chunks.length === 0) {
      // Record mtime so we don't reparse next run
      await store.upsertFile(rel, stat.mtimeMs, [], []);
      processed++;
      continue;
    }
    queue.push({ rel, mtime: stat.mtimeMs, chunks });

    const queueBytes = queue.reduce((acc, q) => acc + q.chunks.reduce((a, c) => a + c.content.length, 0), 0);
    if (queueBytes >= QUEUE_BYTES) {
      const stats = await flushQueue(queue, store);
      processed += stats.files;
      totalChunks += stats.chunks;
      queue.length = 0;
      logProgress(processed, changed, totalChunks);
    }
  }

  if (queue.length) {
    const stats = await flushQueue(queue, store);
    processed += stats.files;
    totalChunks += stats.chunks;
    logProgress(processed, changed, totalChunks);
  }

  console.log(`[code-rag] done — processed ${processed} files, ${totalChunks} chunks, skipped ${skipped} unchanged`);
  const finalStats = await store.stats();
  console.log(`[code-rag] store now has ${finalStats.totalChunks} chunks across ${finalStats.totalFiles} files`);
}

async function flushQueue(queue, store) {
  const allTexts = [];
  for (const item of queue) {
    for (const c of item.chunks) allTexts.push(c.content);
  }
  const t0 = Date.now();
  const vectors = await embedBatch(allTexts);
  const embedMs = Date.now() - t0;

  let cursor = 0;
  let totalChunks = 0;
  for (const item of queue) {
    const slice = vectors.slice(cursor, cursor + item.chunks.length);
    cursor += item.chunks.length;
    await store.upsertFile(item.rel, item.mtime, item.chunks, slice);
    totalChunks += item.chunks.length;
  }
  console.log(`[code-rag]   batch: ${queue.length} files, ${totalChunks} chunks, ${embedMs}ms embed`);
  return { files: queue.length, chunks: totalChunks };
}

function logProgress(processed, changed, totalChunks) {
  const pct = changed > 0 ? Math.round((processed / changed) * 100) : 100;
  console.log(`[code-rag] progress ${processed}/${changed} files (${pct}%), ${totalChunks} chunks indexed`);
}

async function walk(root, dir, ig, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(root, full);
    if (rel.length === 0) continue;
    const relForIgnore = e.isDirectory() ? rel + "/" : rel;
    if (ig.ignores(relForIgnore)) continue;
    if (e.isDirectory()) {
      await walk(root, full, ig, out);
    } else if (e.isFile()) {
      if (!detectLanguage(rel)) continue;
      out.push(full);
    }
  }
}

main().catch((err) => {
  console.error("[code-rag] FATAL", err);
  process.exit(1);
});
