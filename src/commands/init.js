// `code-rag init` — register this package in the repo's MCP config and kick off indexing.
//
// Design:
//  - Auto-detects repo root by walking up for .git (falls back to cwd).
//  - Writes to .mcp.json at the repo root by default (project-scoped, committable).
//    Use --personal to write to .claude/settings.local.json instead (gitignored).
//  - Refuses to overwrite an existing code-rag entry unless --force is passed.
//  - Uses `npx -y code-rag-mcp serve` as the spawn command — portable across machines
//    (no absolute paths baked in), and DATA_DIR is auto-computed per repo at runtime.
//  - Kicks off the first index in a detached background process so `init` returns fast.
//    Progress logs stream to DATA_DIR/index.log — tail it to watch.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findRepoRoot, dataDirFor, mcpConfigPath } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_KEY = "code-rag";

export async function run(args) {
  const force = args.includes("--force");
  const personal = args.includes("--personal");

  const repoRoot = findRepoRoot(process.cwd());
  const dataDir = dataDirFor(repoRoot);

  const configFile = personal
    ? path.join(repoRoot, ".claude", "settings.local.json")
    : mcpConfigPath(repoRoot);

  log(`Repo root: ${repoRoot}`);
  log(`Data dir:  ${dataDir}`);
  log(`Config:    ${configFile}${personal ? "  (personal, gitignored)" : "  (project, committable)"}`);

  const config = readConfig(configFile);
  const serversKey = personal ? "mcpServers" : "mcpServers";
  if (!config[serversKey]) config[serversKey] = {};

  if (config[serversKey][SERVER_KEY] && !force) {
    fail(`code-rag is already registered in ${configFile}. Re-run with --force to overwrite.`);
  }

  config[serversKey][SERVER_KEY] = {
    command: "npx",
    args: ["-y", "code-rag-mcp", "serve"],
  };

  writeConfig(configFile, config);
  log(`✓ Registered '${SERVER_KEY}' in ${path.relative(repoRoot, configFile) || configFile}`);

  fs.mkdirSync(dataDir, { recursive: true });

  const logPath = path.join(dataDir, "index.log");
  const logFd = fs.openSync(logPath, "a");
  const indexerPath = path.resolve(__dirname, "../indexer.js");

  const child = spawn(process.execPath, [indexerPath], {
    env: { ...process.env, REPO_ROOT: repoRoot, DATA_DIR: dataDir },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();

  log(`✓ Indexing started in background (pid ${child.pid})`);
  log(`  tail -f ${logPath}`);
  log("");
  log("Restart Claude Code (or reload MCP servers) to activate code-rag.");
  log("First index takes a few minutes on a typical repo; embeddings model downloads once (~320 MB).");
}

function readConfig(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return {};
  }
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`Could not parse ${file}: ${err.message}`);
  }
}

function writeConfig(file, config) {
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function log(msg) { process.stdout.write(msg + "\n"); }
function fail(msg) { process.stderr.write(`[code-rag init] ${msg}\n`); process.exit(1); }
