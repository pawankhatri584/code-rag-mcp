// `code-rag stats` — print index stats (files, chunks, language distribution).

import { openStore } from "../store.js";
import { resolveConfig } from "../config.js";

export async function run() {
  const { repoRoot, dataDir } = resolveConfig();
  const store = await openStore(dataDir);
  const stats = await store.stats();

  process.stdout.write(`Repo root: ${repoRoot}\n`);
  process.stdout.write(`Data dir:  ${dataDir}\n`);
  process.stdout.write(`Total files indexed: ${stats.totalFiles}\n`);
  process.stdout.write(`Total chunks:        ${stats.totalChunks}\n`);
  process.stdout.write(`Languages (sample of ${stats.sampleSize}):\n`);
  const entries = Object.entries(stats.languages).sort(([, a], [, b]) => b - a);
  for (const [lang, count] of entries) {
    process.stdout.write(`  ${lang}: ${count}\n`);
  }
}
