// `code-rag init` — register this package in the repo's MCP config and kick off indexing.
//
// Modes (how Claude Code will spawn the server):
//   default         `npx -y code-rag-mcp serve`         no install required, always fetches latest
//   --global        `code-rag serve`                     requires `npm install -g code-rag-mcp`
//   --local         `npx code-rag-mcp serve`             requires `npm install --save-dev code-rag-mcp` in target repo
//
// Config destination (where the MCP entry is written):
//   default         <repo>/.mcp.json                     project-scoped, meant to be committed
//   --personal      <repo>/.claude/settings.local.json   project-scoped, gitignored by Claude Code convention
//
// Other flags:
//   --force         overwrite an existing `code-rag` entry instead of erroring

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findRepoRoot, dataDirFor, mcpConfigPath } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_KEY = "code-rag";

export async function run(args) {
  const flags = parseFlags(args);
  if (flags.global && flags.local) {
    fail("--global and --local are mutually exclusive; pick one (or neither for the default npx mode).");
  }

  const repoRoot = findRepoRoot(process.cwd());
  const dataDir = dataDirFor(repoRoot);

  const configFile = flags.personal
    ? path.join(repoRoot, ".claude", "settings.local.json")
    : mcpConfigPath(repoRoot);

  const mode = flags.global ? "global" : flags.local ? "local" : "npx";
  const serverEntry = buildServerEntry(mode);

  log(`Repo root: ${repoRoot}`);
  log(`Data dir:  ${dataDir}`);
  log(`Config:    ${configFile}${flags.personal ? "  (personal, gitignored)" : "  (project, committable)"}`);
  log(`Mode:      ${mode}`);

  // Best-effort install check for global/local modes — warn if the binary isn't there yet.
  if (mode === "global" && !commandExists("code-rag")) {
    warn("`code-rag` binary not found on PATH. Run:  npm install -g code-rag-mcp");
  }
  if (mode === "local") {
    const localBin = path.join(repoRoot, "node_modules", ".bin", "code-rag");
    if (!fs.existsSync(localBin)) {
      warn(`code-rag-mcp is not installed in ${repoRoot}/node_modules. Run:  npm install --save-dev code-rag-mcp`);
    }
  }

  const config = readConfig(configFile);
  if (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  if (config.mcpServers[SERVER_KEY] && !flags.force) {
    fail(`code-rag is already registered in ${configFile}. Re-run with --force to overwrite.`);
  }

  config.mcpServers[SERVER_KEY] = serverEntry;
  writeConfig(configFile, config);
  log(`Registered '${SERVER_KEY}' in ${path.relative(repoRoot, configFile) || configFile}`);

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

  log(`Indexing started in background (pid ${child.pid}).  tail -f ${logPath}`);
  log("");
  log("Restart Claude Code (or reload MCP servers) to activate code-rag.");
  log("First index takes a few minutes on a typical repo; embeddings model downloads once (~320 MB).");
}

function parseFlags(args) {
  return {
    force: args.includes("--force"),
    personal: args.includes("--personal"),
    global: args.includes("--global"),
    local: args.includes("--local"),
  };
}

function buildServerEntry(mode) {
  if (mode === "global") return { command: "code-rag", args: ["serve"] };
  if (mode === "local") return { command: "npx", args: ["code-rag-mcp", "serve"] };
  return { command: "npx", args: ["-y", "code-rag-mcp", "serve"] };
}

function commandExists(cmd) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, cmd + ext))) return true;
    }
  }
  return false;
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
function warn(msg) { process.stderr.write(`warning: ${msg}\n`); }
function fail(msg) { process.stderr.write(`[code-rag init] ${msg}\n`); process.exit(1); }
