// Shared exclude rules used by both the batch indexer and the live watcher.

import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";

export const HARD_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".vercel/",
  "coverage/",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".DS_Store",
  "*.generated.ts",
  "*.generated.js",
  "*.min.js",
  "*.min.css",
];

export function buildIgnore({ repoRoot, dataDir }) {
  const ig = ignore().add(HARD_EXCLUDES);
  const gi = path.join(repoRoot, ".gitignore");
  if (fs.existsSync(gi)) {
    ig.add(fs.readFileSync(gi, "utf8"));
  }
  if (dataDir) {
    const dataRel = path.relative(repoRoot, dataDir);
    if (dataRel && !dataRel.startsWith("..") && !path.isAbsolute(dataRel)) {
      ig.add(dataRel + "/");
    }
  }
  return ig;
}
