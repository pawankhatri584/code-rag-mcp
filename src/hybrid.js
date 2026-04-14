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

const TOKEN_RE = /[a-z0-9_]+/g;
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

export function tokenize(text) {
  if (!text) return [];
  const raw = String(text).toLowerCase().match(TOKEN_RE) || [];
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (t.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Score a chunk's content by how many query tokens it contains, with log-scaled frequency.
// Not true BM25 (no corpus IDF), but good enough as a keyword signal — the RRF fusion with
// vector results normalizes out the magnitude.
export function scoreContent(queryTokens, content) {
  if (queryTokens.length === 0 || !content) return 0;
  const contentTokens = String(content).toLowerCase().match(TOKEN_RE) || [];
  const freq = new Map();
  for (const t of contentTokens) freq.set(t, (freq.get(t) || 0) + 1);
  let score = 0;
  let matched = 0;
  for (const qt of queryTokens) {
    const f = freq.get(qt);
    if (f) {
      score += 1 + Math.log(f);
      matched++;
    }
  }
  // Bonus for matching multiple query terms — pushes chunks that cover the whole query up.
  if (matched > 1) score *= 1 + 0.1 * (matched - 1);
  return score;
}

// Reciprocal Rank Fusion. k=60 is the standard constant from the original paper.
// Output order: highest fused score first. Chunk metadata from either input list is preserved.
export function rrfFuse(listA, listB, { k = 60, limit = 10 } = {}) {
  const scores = new Map();
  const byId = new Map();
  listA.forEach((r, i) => {
    if (!r?.id) return;
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + i));
    if (!byId.has(r.id)) byId.set(r.id, r);
  });
  listB.forEach((r, i) => {
    if (!r?.id) return;
    scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + i));
    if (!byId.has(r.id)) byId.set(r.id, r);
  });
  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([id, score]) => ({ ...byId.get(id), _rrf: score }));
}
