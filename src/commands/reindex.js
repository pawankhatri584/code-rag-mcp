// `code-rag reindex` — run the indexer in the foreground with progress streaming to stdout.
// Pass --force to rebuild every file regardless of mtime.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function run(args) {
  const { repoRoot, dataDir } = resolveConfig();
  const indexerArgs = args.includes("--force") ? ["--reindex"] : [];

  process.stdout.write(`[code-rag] repo root: ${repoRoot}\n`);
  process.stdout.write(`[code-rag] data dir:  ${dataDir}\n\n`);

  const indexerPath = path.resolve(__dirname, "../indexer.js");
  const child = spawn(process.execPath, [indexerPath, ...indexerArgs], {
    env: { ...process.env, REPO_ROOT: repoRoot, DATA_DIR: dataDir },
    stdio: "inherit",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}
