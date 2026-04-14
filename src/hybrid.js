// Hybrid search = keyword matching fused with vector similarity via Reciprocal Rank Fusion.
// Rationale:
//  - Vector search misses when the right chunk's code uses none of the query's exact words
//    (the case where RAG embeddings shine: "auth race condition" finds chunks with "TOCTOU").
//  - Keyword search wins when the user IS searching for an exact term (a function name, a
//    config key, an identifier). Pure vector search deranks exact matches.
//  - RRF blends both rankings without calibrating score magnitudes — robust, simple, standard.
//
// We don't maintain a separate inverted index: LanceDB's SQL WHERE + LIKE is fast enough for
// the scales this tool targets (repos up to tens of thousands of chunks). If that ever
// becomes a bottleneck, swap in LanceDB FTS or a proper BM25 index.
//
// Keyword scoring uses BM25 with corpus IDF: rare tokens (e.g. specific identifiers) score
// much higher than common tokens (e.g. "user", "data"). Document frequencies come from the
// store via countLiteralMatches() — one COUNT(*) per unique query token.

const TOKEN_RE = /[A-Za-z0-9_]+/g;
const MIN_TOKEN_LEN = 2;

// Common English + code stopwords. We strip these from queries so they don't dominate
// LIKE-scans with noise, and so the score isn't boosted by ubiquitous tokens.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "of", "to", "in",
  "on", "at", "by", "with", "as", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "has", "have", "had", "can", "could", "should", "would", "will",
  "this", "that", "these", "those", "it", "its", "we", "us", "you", "your", "i",
  "where", "how", "what", "when", "why", "which", "who", "not", "no",
  "function", "const", "let", "var", "return", "import", "export", "class", "interface",
]);

// Confidence thresholds. Tuned on jina-v2-base-code distance distributions:
// dist ≤ 0.55 = strong semantic match; dist > 0.75 = weak/coincidental similarity.
export const CONFIDENCE_DIST_HIGH = 0.55;
export const CONFIDENCE_DIST_LOW = 0.75;

// BM25 hyperparameters. Standard defaults from the original BM25 paper.
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const AVG_CHUNK_TOKENS = 120; // approximate; chunker targets 800 chars ≈ 100-150 tokens

// A "literal" token is one the user almost certainly typed verbatim expecting an exact match:
// snake_case, SCREAMING_CASE, CamelCase, contains digits, or just very long. These bypass
// stopword filtering so identifiers like `function_name` survive.
function isLiteralIdentifier(rawToken) {
  if (rawToken.length < MIN_TOKEN_LEN) return false;
  return rawToken.includes("_") || /[A-Z]/.test(rawToken) || /\d/.test(rawToken) || rawToken.length > 12;
}

// Returns { tokens, literals }. Both lowercased and deduped.
//  - tokens: keyword-search input (stopwords stripped)
//  - literals: subset that look like verbatim identifiers (used for IDF boosting + UX hints)
export function tokenize(text) {
  const tokens = [];
  const literals = [];
  if (!text) return { tokens, literals };
  const raw = String(text).match(TOKEN_RE) || [];
  const seenTok = new Set();
  const seenLit = new Set();
  for (const rawTok of raw) {
    if (rawTok.length < MIN_TOKEN_LEN) continue;
    const lower = rawTok.toLowerCase();
    if (isLiteralIdentifier(rawTok) && !seenLit.has(lower)) {
      seenLit.add(lower);
      literals.push(lower);
    }
    if (STOPWORDS.has(lower)) continue;
    if (seenTok.has(lower)) continue;
    seenTok.add(lower);
    tokens.push(lower);
  }
  return { tokens, literals };
}

// BM25 score for a single chunk against the query.
//   queryTokens — array of lowercased query terms
//   content     — raw chunk text
//   df          — Map<token, document_frequency> (chunks containing the token)
//   totalDocs   — total number of chunks in the (filtered) corpus; used for IDF
//
// IDF formula: log((N - df + 0.5) / (df + 0.5) + 1) — the +1 keeps it non-negative.
// TF saturation: tf * (k1+1) / (tf + k1 * (1 - b + b * doclen/avgdoclen))
export function bm25Score(queryTokens, content, df, totalDocs) {
  if (!queryTokens?.length || !content) return 0;
  const tokens = String(content).toLowerCase().match(TOKEN_RE) || [];
  if (tokens.length === 0) return 0;
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const docLen = tokens.length;
  const lenNorm = 1 - BM25_B + BM25_B * (docLen / AVG_CHUNK_TOKENS);
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt);
    if (!f) continue;
    const docFreq = df?.get(qt) ?? 1;
    const idf = Math.log((totalDocs - docFreq + 0.5) / (docFreq + 0.5) + 1);
    if (idf <= 0) continue; // ubiquitous token — contributes nothing
    score += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * lenNorm);
  }
  return score;
}

// Reciprocal Rank Fusion with optional per-list weighting.
// Output order: highest fused score first.
// Each output row carries `_rrf` (the fused score) and `_via` ('semantic' | 'keyword' | 'both')
// so downstream formatters can show which signal lifted the result.
//
// Convention: listA is the SEMANTIC results, listB is the KEYWORD results.
// `weightB > 1` boosts the keyword list — use this when the query has literal identifiers
// that exist in the corpus (a strong keyword signal shouldn't be diluted by semantic noise).
export function rrfFuse(listA, listB, { k = 60, limit = 10, weightA = 1, weightB = 1 } = {}) {
  const scores = new Map();
  const byId = new Map();
  const fromA = new Set();
  const fromB = new Set();
  listA.forEach((r, i) => {
    if (!r?.id) return;
    scores.set(r.id, (scores.get(r.id) || 0) + weightA / (k + i));
    if (!byId.has(r.id)) byId.set(r.id, r);
    fromA.add(r.id);
  });
  listB.forEach((r, i) => {
    if (!r?.id) return;
    scores.set(r.id, (scores.get(r.id) || 0) + weightB / (k + i));
    if (!byId.has(r.id)) byId.set(r.id, r);
    fromB.add(r.id);
  });
  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([id, score]) => {
      const inA = fromA.has(id);
      const inB = fromB.has(id);
      const _via = inA && inB ? "both" : inA ? "semantic" : "keyword";
      return { ...byId.get(id), _rrf: score, _via };
    });
}
