// Startup catch-up: scan the repo for files whose mtime has changed since the last index
// and re-embed only those. This runs once on `serve` boot, in the background.
// It's the same logic as `reindex`, but invoked in-process from the MCP server.

import fs from "node:fs/promises";
import path from "node:path";
import { chunkFile, detectLanguage } from "./chunker.js";
import { embedBatch } from "./embedder.js";
import { buildIgnore } from "./excludes.js";

export async function runCatchup({ repoRoot, dataDir, store, onLog = () => {} }) {
  const ig = buildIgnore({ repoRoot, dataDir });
  const existing = await store.getFileMtimes();

  const files = [];
  await walk(repoRoot, repoRoot, ig, files);

  const stale = [];
  for (const full of files) {
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      const rel = path.relative(repoRoot, full);
      const prev = existing.get(rel);
      if (prev === undefined || prev !== Math.floor(stat.mtimeMs)) {
        stale.push({ full, rel, mtime: stat.mtimeMs });
      }
    } catch {}
  }

  if (stale.length === 0) {
    onLog("catchup: index is up to date");
    return;
  }
  onLog(`catchup: ${stale.length} file(s) changed since last index — re-embedding in background`);

  // Batch in modest chunks so we don't starve queries during a long catch-up.
  const BATCH = 20;
  let totalChunks = 0;
  for (let i = 0; i < stale.length; i += BATCH) {
    const group = stale.slice(i, i + BATCH);
    const prepared = [];
    for (const { full, rel, mtime } of group) {
      try {
        const src = await fs.readFile(full, "utf8");
        const chunks = chunkFile(rel, src);
        prepared.push({ rel, mtime, chunks });
      } catch {}
    }
    const allTexts = prepared.flatMap((f) => f.chunks.map((c) => c.content));
    const vectors = allTexts.length > 0 ? await embedBatch(allTexts) : [];
    let cursor = 0;
    for (const f of prepared) {
      const slice = vectors.slice(cursor, cursor + f.chunks.length);
      cursor += f.chunks.length;
      await store.upsertFile(f.rel, f.mtime, f.chunks, slice);
    }
    totalChunks += allTexts.length;
  }
  onLog(`catchup: re-embedded ${stale.length} file(s), ${totalChunks} chunks`);
}

async function walk(root, dir, ig, out) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
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
