#!/usr/bin/env node
// Quick smoke test: run a few generic queries against the index and print top hits.
// Usage: REPO_ROOT=... DATA_DIR=... node src/smoke.js
// Or pass your own queries as CLI args: node src/smoke.js "custom query one" "another"

import { openStore } from "./store.js";
import { embedQuery } from "./embedder.js";
import { resolveConfig } from "./config.js";

const { dataDir: DATA_DIR } = resolveConfig();

const DEFAULT_QUERIES = [
  "authentication flow",
  "database connection setup",
  "error handling middleware",
  "unit test for the main entry point",
];
const QUERIES = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_QUERIES;

async function main() {
  const store = await openStore(DATA_DIR);
  for (const q of QUERIES) {
    console.log(`\n========== "${q}" ==========`);
    const vec = await embedQuery(q);
    const rows = await store.search(vec, { k: 3 });
    if (rows.length === 0) {
      console.log("  (no results)");
      continue;
    }
    for (const r of rows) {
      const dist = typeof r._distance === "number" ? r._distance.toFixed(3) : "?";
      const preview = (r.content || "").replace(/\s+/g, " ").slice(0, 120);
      console.log(`  [${dist}] ${r.path}:${r.start_line}-${r.end_line}`);
      console.log(`         ${preview}`);
    }
  }
  const stats = await store.stats();
  console.log("\n----- index stats -----");
  console.log(`files:  ${stats.totalFiles}`);
  console.log(`chunks: ${stats.totalChunks}`);
  console.log("languages:", stats.languages);
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
