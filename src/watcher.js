// Live index watcher. Runs in-process alongside the MCP server.
// Debounces filesystem events, re-embeds changed files, prunes deletions.
//
// Design:
//  - chokidar.watch() on REPO_ROOT with ignoreInitial so we don't re-process the whole repo
//    on startup. The separate `startupCatchup()` call handles mtime-based catch-up once.
//  - awaitWriteFinish avoids reading half-written files during editor saves.
//  - Events are coalesced into a Map keyed by relative path. Kind wins last-write:
//    change → add → unlink collapses to whatever the latest state is.
//  - Debounce window of 2s means a burst of saves (formatter run, large refactor) flushes once.
//  - Embedding is CPU-bound — flushing is sequential, so a slow flush doesn't spawn concurrent
//    embedder calls that would thrash CPU.

import chokidar from "chokidar";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { chunkFile, detectLanguage } from "./chunker.js";
import { embedBatch } from "./embedder.js";
import { buildIgnore } from "./excludes.js";

const DEBOUNCE_MS = 2000;

export function startWatcher({ repoRoot, dataDir, store, onLog = () => {}, onError = () => {} }) {
  const ig = buildIgnore({ repoRoot, dataDir });
  const pending = new Map(); // relPath -> "change" | "unlink"
  let timer = null;
  let flushing = false;
  let closed = false;

  function relOf(full) {
    const rel = path.relative(repoRoot, full);
    return !rel || rel.startsWith("..") ? null : rel;
  }

  function shouldSkip(rel, isDir = false) {
    if (!rel) return true;
    if (ig.ignores(isDir ? rel + "/" : rel)) return true;
    if (!isDir && !detectLanguage(rel)) return true;
    return false;
  }

  function enqueue(full, kind) {
    const rel = relOf(full);
    if (shouldSkip(rel)) return;
    pending.set(rel, kind);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush().catch(onError);
    }, DEBOUNCE_MS);
  }

  async function flush() {
    if (flushing || closed || pending.size === 0) return;
    flushing = true;
    const batch = [...pending.entries()];
    pending.clear();
    try {
      const unlinked = batch.filter(([, k]) => k === "unlink").map(([rel]) => rel);
      for (const rel of unlinked) {
        await store.deleteFileChunks(rel);
      }

      const changed = batch.filter(([, k]) => k !== "unlink").map(([rel]) => rel);
      const prepared = [];
      for (const rel of changed) {
        const full = path.join(repoRoot, rel);
        try {
          const stat = await fs.stat(full);
          if (!stat.isFile()) continue;
          const source = await fs.readFile(full, "utf8");
          const chunks = chunkFile(rel, source);
          prepared.push({ rel, mtime: stat.mtimeMs, chunks });
        } catch {
          // File disappeared or unreadable between event and read — skip.
        }
      }

      if (prepared.length === 0 && unlinked.length === 0) return;

      const allTexts = prepared.flatMap((f) => f.chunks.map((c) => c.content));
      const vectors = allTexts.length > 0 ? await embedBatch(allTexts) : [];

      let cursor = 0;
      for (const f of prepared) {
        const slice = vectors.slice(cursor, cursor + f.chunks.length);
        cursor += f.chunks.length;
        await store.upsertFile(f.rel, f.mtime, f.chunks, slice);
      }

      const summary = [
        prepared.length > 0 ? `${prepared.length} changed (${allTexts.length} chunks)` : null,
        unlinked.length > 0 ? `${unlinked.length} removed` : null,
      ].filter(Boolean).join(", ");
      if (summary) onLog(`watcher: ${summary}`);
    } finally {
      flushing = false;
      if (pending.size > 0) scheduleFlush();
    }
  }

  const watcher = chokidar.watch(repoRoot, {
    ignored: (target) => {
      const rel = relOf(target);
      if (rel === null) return false; // the repo root itself
      // chokidar may hand us directories without a trailing slash — check both.
      if (ig.ignores(rel)) return true;
      try {
        if (existsSync(target) && statSync(target).isDirectory() && ig.ignores(rel + "/")) return true;
      } catch {}
      return false;
    },
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  // Filter system-level noise (EACCES on sockets, UNKNOWN on OS-managed files in /tmp, etc.)
  // — these are not actionable and would flood stderr on certain repo roots.
  const NOISY_CODES = new Set(["EACCES", "EPERM", "EBUSY", "UNKNOWN", "ENOENT", "ENOTDIR"]);
  watcher
    .on("add", (p) => enqueue(p, "change"))
    .on("change", (p) => enqueue(p, "change"))
    .on("unlink", (p) => enqueue(p, "unlink"))
    .on("error", (err) => {
      if (err && NOISY_CODES.has(err.code)) return;
      onError(err);
    });

  return {
    async stop() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await flush().catch(onError);
      await watcher.close();
    },
  };
}
