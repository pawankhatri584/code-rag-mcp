// Shared configuration: repo root detection, data dir computation, MCP config paths.
// Everything here must work without any user-specific assumptions — this package
// is repo-local, configured from cwd or env vars alone.

import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function findRepoRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir); // hit filesystem root — fall back to cwd
    dir = parent;
  }
}

export function dataDirFor(repoRoot) {
  const hash = crypto.createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 16);
  return path.join(os.homedir(), ".cache", "code-rag", hash);
}

export function resolveConfig() {
  const repoRoot = process.env.REPO_ROOT
    ? path.resolve(process.env.REPO_ROOT)
    : findRepoRoot(process.cwd());
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : dataDirFor(repoRoot);
  return { repoRoot, dataDir };
}

export function mcpConfigPath(repoRoot) {
  return path.join(repoRoot, ".mcp.json");
}
