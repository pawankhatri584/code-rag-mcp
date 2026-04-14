#!/usr/bin/env node
// MCP server. Exposes code_search, exists, get_chunk, index_stats over stdio.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { openStore } from "./store.js";
import { embedQuery } from "./embedder.js";
import { resolveConfig } from "./config.js";
import { startWatcher } from "./watcher.js";
import { runCatchup } from "./catchup.js";
import { maybeCheckForUpdates } from "./update-check.js";
import {
  tokenize,
  bm25Score,
  rrfFuse,
  CONFIDENCE_DIST_HIGH,
  CONFIDENCE_DIST_LOW,
} from "./hybrid.js";

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
        "jina-code embedded, BM25-scored, RRF-fused). Returns ranked code snippets with file " +
        "paths, line ranges, and per-result attribution (`via=semantic|keyword|both`, `kw_hits=N`). " +
        "When the query contains literal identifiers (snake_case, CamelCase, ALL_CAPS), surfaces " +
        "their corpus counts and flags low confidence if zero chunks contain them. " +
        "Use this when intent matters more than exact strings (e.g. 'where do we handle JWT refresh'). " +
        "For pure presence/absence questions ('does this string exist anywhere?'), prefer the " +
        "`exists` tool — it's definitive and faster.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or code-snippet query" },
          k: { type: "number", description: "Max results (default 10, max 50)", default: 10 },
          mode: {
            type: "string",
            enum: ["hybrid", "semantic", "keyword"],
            description: "Search mode (default 'hybrid'). 'semantic' = vector only. 'keyword' = BM25 token match only.",
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
          path_glob_exclude: {
            type: "string",
            description: "Exclude paths matching this LIKE pattern, e.g. '.claude/%' to drop docs",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "exists",
      description:
        "Definitive presence check for a literal substring across the indexed corpus. " +
        "Grep-equivalent companion to `code_search` — returns count + sample locations, or zero. " +
        "Use this for 'does X appear anywhere?' questions; it's faster than code_search and " +
        "gives an unambiguous answer (no semantic noise, no ranking guesses).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal substring to search for. Case-insensitive." },
          path_glob: { type: "string", description: "SQL LIKE filter (use %), optional" },
          path_glob_exclude: { type: "string", description: "SQL NOT LIKE filter, optional" },
          language: { type: "string", description: "Filter by language, optional" },
          max_locations: { type: "number", description: "Sample locations to return (default 20, max 200)", default: 20 },
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
      description: "Inspect the code-rag index: total chunks, total files, language distribution, stale-file estimate.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "code_search") return await codeSearch(args);
    if (name === "exists") return await existsTool(args);
    if (name === "get_chunk") return await getChunk(args);
    if (name === "index_stats") return await indexStats();
    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
  }
});

async function codeSearch({ query, k = 10, mode = "hybrid", language, path_glob, path_glob_exclude }) {
  if (!query || typeof query !== "string") throw new Error("query is required");
  const cap = Math.min(Math.max(1, Number(k) || 10), 50);
  const s = await store();
  const { tokens, literals } = tokenize(query);
  const filters = { language, pathGlob: path_glob, pathGlobExclude: path_glob_exclude };
  // If the query reduces to zero useful tokens (pure stopwords/punctuation),
  // there's nothing to match with keyword — fall back to semantic.
  const effectiveMode = mode === "keyword" && tokens.length === 0 ? "semantic" : mode;

  // Document frequencies. Always include literals (even in semantic mode) so the
  // literal-tokens header is accurate. For keyword/hybrid we additionally need DF
  // for non-literal tokens so BM25 IDF can downweight common ones.
  const dfTokens = effectiveMode === "semantic"
    ? [...new Set(literals)]
    : [...new Set([...tokens, ...literals])];
  const dfPromise = dfTokens.length > 0
    ? s.countLiteralMatches(dfTokens, filters)
    : Promise.resolve(new Map());
  const totalDocsPromise = s.countChunks();

  let rows;
  let df = new Map();
  let totalDocs = 0;

  if (effectiveMode === "semantic") {
    const [vec, dfRes] = await Promise.all([embedQuery(query), dfPromise]);
    df = dfRes;
    rows = await s.search(vec, { k: cap, ...filters });
    rows.forEach((r) => { r._via = "semantic"; });
  } else if (effectiveMode === "keyword") {
    const [dfRes, totalDocsRes, candidates] = await Promise.all([
      dfPromise,
      totalDocsPromise,
      s.keywordCandidates(tokens, { candidateLimit: cap * 20, ...filters }),
    ]);
    df = dfRes;
    totalDocs = totalDocsRes;
    rows = candidates
      .map((r) => ({ ...r, _keywordScore: bm25Score(tokens, r.content, df, totalDocs), _via: "keyword" }))
      .sort((a, b) => b._keywordScore - a._keywordScore)
      .slice(0, cap);
  } else {
    // hybrid: do both, fuse with weighted RRF
    const poolSize = Math.max(cap * 3, 30);
    const [vec, candidates, dfRes, totalDocsRes] = await Promise.all([
      embedQuery(query),
      tokens.length > 0
        ? s.keywordCandidates(tokens, { candidateLimit: poolSize, ...filters })
        : Promise.resolve([]),
      dfPromise,
      totalDocsPromise,
    ]);
    df = dfRes;
    totalDocs = totalDocsRes;
    const vectorResults = await s.search(vec, { k: poolSize, ...filters });
    const keywordResults = candidates
      .map((r) => ({ ...r, _keywordScore: bm25Score(tokens, r.content, df, totalDocs) }))
      .sort((a, b) => b._keywordScore - a._keywordScore)
      .slice(0, poolSize);
    // Adaptive weight: when literals exist AND any have matches in corpus, the keyword
    // signal is meaningful — boost it so it isn't drowned by semantically-similar noise.
    const literalsHaveMatches = literals.some((l) => (df.get(l) || 0) > 0);
    const weightB = literals.length > 0 && literalsHaveMatches ? 1.6 : 1.0;
    rows = rrfFuse(vectorResults, keywordResults, { limit: cap, weightB });
  }

  // Confidence calculation
  const bestDist = rows.find((r) => typeof r._distance === "number")?._distance;
  let confidence = "medium";
  if (literals.length > 0) {
    const anyExists = literals.some((l) => (df.get(l) || 0) > 0);
    if (!anyExists) {
      confidence = "low";
    } else if (bestDist != null && bestDist <= CONFIDENCE_DIST_HIGH) {
      confidence = "high";
    } else if (effectiveMode === "keyword") {
      // keyword mode + literal exists in corpus → high confidence (we have actual matches)
      confidence = "high";
    }
  } else if (bestDist != null) {
    if (bestDist <= CONFIDENCE_DIST_HIGH) confidence = "high";
    else if (bestDist > CONFIDENCE_DIST_LOW) confidence = "low";
  } else if (effectiveMode === "keyword" && rows.length > 0) {
    confidence = "high";
  }

  // Stale-index check on result paths
  const resultPaths = [...new Set(rows.map((r) => r.path))];
  const stale = await checkStaleness(s, resultPaths);

  // Build header
  const headerLines = [];
  if (literals.length > 0) {
    const litStr = literals.map((l) => `${l}=${df.get(l) ?? 0}`).join(", ");
    headerLines.push(`literal tokens: ${litStr}`);
  }
  if (confidence !== "high") {
    const reasons = [];
    if (bestDist != null) reasons.push(`best dist=${bestDist.toFixed(3)}`);
    if (literals.length > 0 && literals.every((l) => (df.get(l) || 0) === 0)) {
      reasons.push("no chunk contains the query as a literal");
    }
    headerLines.push(`⚠ confidence: ${confidence}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`);
    if (confidence === "low") {
      headerLines.push(`  Try the \`exists\` tool, mode:"keyword", or rephrase the query.`);
    }
  }
  if (stale.length > 0) {
    const sample = stale[0].path;
    headerLines.push(
      `⚠ index stale — ${stale.length} of ${resultPaths.length} result file(s) modified since indexing (e.g., ${sample}). Watcher should pick up within ~2s; rerun if results look wrong.`
    );
  }

  if (rows.length === 0) {
    const text = headerLines.length > 0
      ? headerLines.join("\n") + `\n\nNo matches for "${query}".`
      : `No matches for "${query}".`;
    return { content: [{ type: "text", text }] };
  }

  // Per-result formatting with attribution
  const literalsLower = literals; // already lowercase
  const formatted = rows.map((r, i) => {
    const scoreBits = [];
    if (r._via) scoreBits.push(`via=${r._via}`);
    if (literalsLower.length > 0 && r.content) {
      const contentLower = r.content.toLowerCase();
      // Substring count per literal (handles overlapping snake_case tokens fine).
      let hits = 0;
      for (const lit of literalsLower) {
        if (!lit) continue;
        let idx = 0;
        while ((idx = contentLower.indexOf(lit, idx)) !== -1) { hits++; idx += lit.length; }
      }
      scoreBits.push(`kw_hits=${hits}`);
    }
    if (typeof r._distance === "number") scoreBits.push(`dist=${r._distance.toFixed(3)}`);
    if (typeof r._rrf === "number") scoreBits.push(`rrf=${r._rrf.toFixed(4)}`);
    if (typeof r._keywordScore === "number" && r._rrf === undefined) scoreBits.push(`bm25=${r._keywordScore.toFixed(2)}`);
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

  const finalText = headerLines.length > 0 ? headerLines.join("\n") + "\n\n" + formatted : formatted;
  return { content: [{ type: "text", text: finalText }] };
}

async function existsTool({ query, path_glob, path_glob_exclude, language, max_locations = 20 }) {
  if (!query || typeof query !== "string") throw new Error("query is required");
  const limit = Math.min(Math.max(1, Number(max_locations) || 20), 200);
  const s = await store();
  const { count, fileCount, sample, fileCountExact } = await s.countAndSampleLiteral(query, {
    pathGlob: path_glob,
    pathGlobExclude: path_glob_exclude,
    language,
    sampleLimit: limit,
  });
  const scopeBits = [];
  if (path_glob) scopeBits.push(`path_glob=${path_glob}`);
  if (path_glob_exclude) scopeBits.push(`path_glob_exclude=${path_glob_exclude}`);
  if (language) scopeBits.push(`language=${language}`);
  const scope = scopeBits.length > 0 ? ` (${scopeBits.join(", ")})` : "";

  if (count === 0) {
    return { content: [{ type: "text", text: `exists: false\nquery: "${query}"${scope}\ncount: 0` }] };
  }
  const fileCountStr = fileCountExact ? `${fileCount}` : `≥${fileCount}`;
  const lines = [
    `exists: true`,
    `query: "${query}"${scope}`,
    `count: ${count} chunk(s) across ${fileCountStr} file(s)`,
    `sample (${sample.length} of ${count}):`,
    ...sample.map((row) => `  ${row.path}:${row.start_line}-${row.end_line}`),
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
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
  const allMtimes = await s.getFileMtimes();
  const allPaths = [...allMtimes.keys()];
  const sampleSize = Math.min(100, allPaths.length);
  const sampled = pickRandomSample(allPaths, sampleSize);
  let staleInSample = 0;
  let missingInSample = 0;
  for (const p of sampled) {
    try {
      const st = await stat(path.resolve(REPO_ROOT, p));
      if (Math.floor(st.mtimeMs) > allMtimes.get(p)) staleInSample++;
    } catch {
      missingInSample++;
    }
  }
  const langLines = Object.entries(stats.languages)
    .sort(([, a], [, b]) => b - a)
    .map(([l, n]) => `  ${l}: ${n}`)
    .join("\n");
  const text = [
    `Repo root: ${REPO_ROOT}`,
    `Data dir:  ${DATA_DIR}`,
    `Total files indexed: ${stats.totalFiles}`,
    `Total chunks:        ${stats.totalChunks}`,
    `Stale (sample):      ${staleInSample}/${sampleSize} indexed files have newer disk mtime` +
      (missingInSample > 0 ? ` (${missingInSample} missing on disk)` : ""),
    `Languages (sample of ${stats.sampleSize}):`,
    langLines,
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

async function checkStaleness(s, paths) {
  if (!paths.length) return [];
  const stored = await s.getStoredMtimes(paths);
  const stale = [];
  for (const p of paths) {
    const storedMtime = stored.get(p);
    if (storedMtime == null) continue;
    try {
      const st = await stat(path.resolve(REPO_ROOT, p));
      if (Math.floor(st.mtimeMs) > storedMtime) stale.push({ path: p });
    } catch {
      // file missing; let the watcher handle deletion
    }
  }
  return stale;
}

function pickRandomSample(arr, n) {
  const a = [...arr];
  const lim = Math.min(n, a.length);
  for (let i = 0; i < lim; i++) {
    const j = i + Math.floor(Math.random() * (a.length - i));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, lim);
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
