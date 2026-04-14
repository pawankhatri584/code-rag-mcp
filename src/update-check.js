// Opt-in: compare installed version to the latest published on npm and log a notice.
// Off by default. Enabled with CODE_RAG_CHECK_UPDATES=1.
// Network call is best-effort with a 3-second timeout — never throws, never blocks startup.

import https from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG_URL = new URL("../package.json", import.meta.url);

export async function maybeCheckForUpdates({ log = () => {} } = {}) {
  if (process.env.CODE_RAG_CHECK_UPDATES !== "1") return;

  let current;
  try {
    current = JSON.parse(readFileSync(fileURLToPath(PKG_URL), "utf8")).version;
  } catch {
    return;
  }

  const latest = await fetchLatest().catch(() => null);
  if (!latest || latest === current) return;
  log(`v${latest} is available (you have v${current}). Update:  npm install -g code-rag-mcp@latest`);
}

function fetchLatest() {
  return new Promise((resolve, reject) => {
    const req = https.get("https://registry.npmjs.org/code-rag-mcp/latest", { timeout: 3000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`status ${res.statusCode}`)); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body).version); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}
