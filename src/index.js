#!/usr/bin/env node
// MCP server. Exposes code_search, get_chunk, index_stats over stdio.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openStore } from "./store.js";
import { embedQuery } from "./embedder.js";
import { resolveConfig } from "./config.js";

const { repoRoot: REPO_ROOT, dataDir: DATA_DIR } = resolveConfig();

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
        "Semantic search over the local repository (tree-sitter chunked, jina-code embedded). " +
        "Returns ranked code snippets with file paths and line ranges. " +
        "Use this instead of grep when intent matters more than exact strings " +
        "(e.g. 'where do we handle JWT refresh', 'auth race condition fix').",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or code-snippet query" },
          k: { type: "number", description: "Max results (default 10, max 50)", default: 10 },
          language: {
            type: "string",
            description: "Filter by language: typescript, tsx, javascript, rust, python, json, md, html, css, sh, sql, yaml, toml",
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

async function codeSearch({ query, k = 10, language, path_glob }) {
  if (!query || typeof query !== "string") throw new Error("query is required");
  const cap = Math.min(Math.max(1, Number(k) || 10), 50);
  const s = await store();
  const vec = await embedQuery(query);
  const rows = await s.search(vec, { k: cap, language, pathGlob: path_glob });

  if (rows.length === 0) {
    return { content: [{ type: "text", text: `No matches for "${query}".` }] };
  }

  const formatted = rows.map((r, i) => {
    const distance = typeof r._distance === "number" ? r._distance.toFixed(3) : "?";
    const preview = (r.content || "").slice(0, 800);
    const truncated = (r.content || "").length > 800 ? "\n... [truncated — use get_chunk for full content]" : "";
    return [
      `[${i + 1}] ${r.path}:${r.start_line}-${r.end_line}  (${r.language}, dist=${distance})`,
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
console.error("[code-rag] MCP server listening on stdio");
