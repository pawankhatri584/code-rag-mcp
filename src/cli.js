#!/usr/bin/env node
// code-rag CLI. Subcommands: init, serve, reindex, stats, help.
// `serve` is what Claude Code invokes over stdio; the others are for humans.

import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [, , rawCmd, ...args] = process.argv;
const cmd = (rawCmd || "").toLowerCase();

const HELP = `code-rag — repo-local semantic code search over MCP

Usage:
  code-rag init [--force] [--personal]   Register code-rag in this repo's .mcp.json and start indexing
  code-rag serve                          Run the MCP stdio server (invoked by Claude Code)
  code-rag reindex [--force]              Re-scan the repo; --force rebuilds every file
  code-rag stats                          Print index stats (files, chunks, languages)
  code-rag help                           Show this message

Environment:
  REPO_ROOT   Override auto-detected repo root (default: nearest .git ancestor of cwd)
  DATA_DIR    Override index location (default: ~/.cache/code-rag/<repo-hash>/)

Docs: https://github.com/pawankhatri584/code-rag-mcp
`;

async function main() {
  switch (cmd) {
    case "init":
      await (await import("./commands/init.js")).run(args);
      break;
    case "serve":
    case "":
    case undefined:
      // Default to serve so `npx code-rag-mcp` with no args works as an MCP server.
      await import("./index.js");
      break;
    case "reindex":
    case "index":
      await (await import("./commands/reindex.js")).run(args);
      break;
    case "stats":
      await (await import("./commands/stats.js")).run(args);
      break;
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`[code-rag] ${err.stack || err.message}\n`);
  process.exit(1);
});
