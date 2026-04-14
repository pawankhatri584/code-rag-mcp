#!/usr/bin/env node
// MCP server. Exposes code_search, get_chunk, index_stats over stdio.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openStore } from "./store.js";
import { embedQuery } from "./embedder.js";
import { resolveConfig } from "./config.js";
import { startWatcher } from "./watcher.js";
import { runCatchup } from "./catchup.js";
import { maybeCheckForUpdates } from "./update-check.js";
import { tokenize, scoreContent, rrfFuse } from "./hybrid.js";

const { repoRoot: REPO_ROOT, dataDir: DATA_DIR } = resolveConfig();
const WATCH_ENABLED = process.env.CODE_RAG_WATCH !== "0";
const CATCHUP_ENABLED = process.env.CODE_RAG_STARTUP_SCAN !== "0";

function stderr(msg) { process.stderr.write(`[code-rag] ${msg}\n`); }

let storePromise = null;
function store() {
  if (!storePromise) storePromise = openStore(DATA_DIR);
  return storePromise;
}

const server = new Server(
  { name: "code-rag", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "code_search",
      description:
        "Hybrid semantic + keyword search over the local repository (tree-sitter chunked, " +
        "jina-code embedded, RRF-fused with keyword match). Returns ranked code snippets with " +
        "file paths and line ranges. Use this instead of grep when intent matters more than " +
        "exact strings (e.g. 'where do we handle JWT refresh', 'auth race condition fix'), " +
        "but also beats pure grep for exact identifier lookups because the keyword signal " +
        "pulls literal matches to the top.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or code-snippet query" },
          k: { type: "number", description: "Max results (default 10, max 50)", default: 10 },
          mode: {
            type: "string",
            enum: ["hybrid", "semantic", "keyword"],
            description: "Search mode (default 'hybrid'). 'semantic' = vector only. 'keyword' = BM25-style token match only.",
            default: "hybrid",
          },
          language: {
            type: "string",
            description: "Filter by language: typescript, tsx, javascript, rust, python, go, java, ruby, c, cpp, php, csharp, json, md, html, css, sh, sql, yaml, toml",
          },
          path_glob: {
            type: "string",
            description: "Filter by path with SQL LIKE wildcards (use % not *), e.g. 'src/addin/%'",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_chunk",
      description: "Fetch the full content of a single chunk by its ID (returned by code_search).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Chunk id, e.g. 'src/foo.ts:10-42'" } },
        required: ["id"],
      },
    },
    {
      name: "index_stats",
      description: "Inspect the code-rag index: total chunks, total files, language distribution.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "code_search") return await codeSearch(args);
    if (name === "get_chunk") return await getChunk(args);
    if (name === "index_stats") return await indexStats();
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
  }
});

async function codeSearch({ query, k = 10, mode = "hybrid", language, path_glob }) {
  if (!query || typeof query !== "string") throw new Error("query is required");
  const cap = Math.min(Math.max(1, Number(k) || 10), 50);
  const s = await store();
  const tokens = tokenize(query);
  // If the query reduces to zero useful tokens (pure stopwords/punctuation),
  // there's nothing to match with keyword — fall back to semantic.
  const effectiveMode = mode === "keyword" && tokens.length === 0 ? "semantic" : mode;

  let rows;
  if (effectiveMode === "semantic") {
    const vec = await embedQuery(query);
    rows = await s.search(vec, { k: cap, language, pathGlob: path_glob });
  } else if (effectiveMode === "keyword") {
    const candidates = await s.keywordCandidates(tokens, { candidateLimit: cap * 20, language, pathGlob: path_glob });
    rows = candidates
      .map((r) => ({ ...r, _keywordScore: scoreContent(tokens, r.content) }))
      .sort((a, b) => b._keywordScore - a._keywordScore)
      .slice(0, cap);
  } else {
    // hybrid: do both, fuse with RRF
    const poolSize = Math.max(cap * 3, 30);
    const [vec, candidates] = await Promise.all([
      embedQuery(query),
      tokens.length > 0
        ? s.keywordCandidates(tokens, { candidateLimit: poolSize, language, pathGlob: path_glob })
        : Promise.resolve([]),
    ]);
    const vectorResults = await s.search(vec, { k: poolSize, language, pathGlob: path_glob });
    const keywordResults = candidates
      .map((r) => ({ ...r, _keywordScore: scoreContent(tokens, r.content) }))
      .sort((a, b) => b._keywordScore - a._keywordScore)
      .slice(0, poolSize);
    rows = rrfFuse(vectorResults, keywordResults, { limit: cap });
  }

  if (rows.length === 0) {
    return { content: [{ type: "text", text: `No matches for "${query}".` }] };
  }

  const formatted = rows.map((r, i) => {
    const scoreBits = [];
    if (typeof r._distance === "number") scoreBits.push(`dist=${r._distance.toFixed(3)}`);
    if (typeof r._rrf === "number") scoreBits.push(`rrf=${r._rrf.toFixed(4)}`);
    if (typeof r._keywordScore === "number" && r._rrf === undefined) scoreBits.push(`kw=${r._keywordScore.toFixed(2)}`);
    const scoreStr = scoreBits.length > 0 ? `, ${scoreBits.join(", ")}` : "";
    const preview = (r.content || "").slice(0, 800);
    const truncated = (r.content || "").length > 800 ? "\n... [truncated — use get_chunk for full content]" : "";
    return [
      `[${i + 1}] ${r.path}:${r.start_line}-${r.end_line}  (${r.language}${scoreStr})`,
      `id: ${r.id}`,
      "```" + (r.language === "tsx" ? "tsx" : r.language),
      preview + truncated,
      "```",
    ].join("\n");
  }).join("\n\n");

  return { content: [{ type: "text", text: formatted }] };
}

async function getChunk({ id }) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  const s = await store();
  const row = await s.getChunk(id);
  if (!row) return { content: [{ type: "text", text: `No chunk with id ${id}` }], isError: true };
  const text = [
    `${row.path}:${row.start_line}-${row.end_line}  (${row.language})`,
    "```" + (row.language === "tsx" ? "tsx" : row.language),
    row.content,
    "```",
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

async function indexStats() {
  const s = await store();
  const stats = await s.stats();
  const langLines = Object.entries(stats.languages)
    .sort(([, a], [, b]) => b - a)
    .map(([l, n]) => `  ${l}: ${n}`)
    .join("\n");
  const text = [
    `Repo root: ${REPO_ROOT}`,
    `Data dir:  ${DATA_DIR}`,
    `Total files indexed: ${stats.totalFiles}`,
    `Total chunks:        ${stats.totalChunks}`,
    `Languages (sample of ${stats.sampleSize}):`,
    langLines,
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

const transport = new StdioServerTransport();
await server.connect(transport);
stderr(`MCP server listening on stdio (repo: ${REPO_ROOT})`);

// Background tasks kicked off AFTER transport connect so queries are never blocked on them.
// All failures are swallowed with a stderr log — the server stays serving even if catch-up
// or the watcher can't start.
(async () => {
  try {
    const s = await store();
    if (CATCHUP_ENABLED) {
      runCatchup({ repoRoot: REPO_ROOT, dataDir: DATA_DIR, store: s, onLog: stderr })
        .catch((err) => stderr(`catchup error: ${err.message}`));
    }
    if (WATCH_ENABLED) {
      const handle = startWatcher({
        repoRoot: REPO_ROOT,
        dataDir: DATA_DIR,
        store: s,
        onLog: stderr,
        onError: (err) => stderr(`watcher error: ${err.message}`),
      });
      const shutdown = async () => { try { await handle.stop(); } catch {} process.exit(0); };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      stderr(`watcher active (disable with CODE_RAG_WATCH=0)`);
    }
  } catch (err) {
    stderr(`background init failed: ${err.message}`);
  }
})();

maybeCheckForUpdates({ log: stderr }).catch(() => {});
