// Tree-sitter chunker. Splits source at function/class boundaries; falls back
// to line-windowing for non-code text. Returns chunks with file path, language,
// 1-indexed start/end lines, and content.

import Parser from "tree-sitter";
import JS from "tree-sitter-javascript";
import TS from "tree-sitter-typescript";
import Rust from "tree-sitter-rust";
import Python from "tree-sitter-python";

const MAX_CHARS = 2000;
const MIN_CHARS = 100;
const TARGET_CHARS = 800;
const WINDOW_LINES = 60;
const OVERLAP_LINES = 8;

const LANG_BY_EXT = {
  ".ts": { name: "typescript", parser: TS.typescript },
  ".tsx": { name: "tsx", parser: TS.tsx },
  ".js": { name: "javascript", parser: JS },
  ".jsx": { name: "javascript", parser: JS },
  ".mjs": { name: "javascript", parser: JS },
  ".cjs": { name: "javascript", parser: JS },
  ".rs": { name: "rust", parser: Rust },
  ".py": { name: "python", parser: Python },
};

const TEXT_EXT = new Set([
  ".json", ".md", ".html", ".css", ".scss", ".sh", ".bash", ".zsh",
  ".yml", ".yaml", ".toml", ".sql", ".txt", ".env", ".conf",
]);

const CHUNKABLE_NODES = new Set([
  // TS/JS
  "function_declaration", "class_declaration", "method_definition",
  "interface_declaration", "type_alias_declaration", "enum_declaration",
  "lexical_declaration", "variable_declaration", "export_statement",
  "function_expression", "arrow_function", "generator_function_declaration",
  // Rust
  "function_item", "impl_item", "struct_item", "enum_item",
  "trait_item", "mod_item", "macro_definition", "use_declaration",
  // Python
  "function_definition", "class_definition", "decorated_definition",
]);

const parserCache = new Map();
function getParser(spec) {
  if (parserCache.has(spec.name)) return parserCache.get(spec.name);
  const p = new Parser();
  p.setLanguage(spec.parser);
  parserCache.set(spec.name, p);
  return p;
}

export function detectLanguage(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  if (LANG_BY_EXT[ext]) return { kind: "code", ...LANG_BY_EXT[ext] };
  if (TEXT_EXT.has(ext)) return { kind: "text", name: ext.slice(1) };
  return null;
}

export function chunkFile(filePath, source) {
  const lang = detectLanguage(filePath);
  if (!lang) return [];
  if (source.length === 0) return [];
  // Files larger than ~500KB are almost always generated/data — skip.
  if (source.length > 500_000) return [];

  if (lang.kind === "text") {
    return windowChunks(filePath, lang.name, source);
  }
  return treeSitterChunks(filePath, lang, source);
}

function treeSitterChunks(filePath, lang, source) {
  const parser = getParser(lang);
  let tree;
  try {
    tree = parser.parse(source);
  } catch {
    return windowChunks(filePath, lang.name, source);
  }

  const root = tree.rootNode;
  const ranges = [];
  collectRanges(root, ranges);

  if (ranges.length === 0) {
    return windowChunks(filePath, lang.name, source);
  }

  // Sort by start, merge tiny adjacent ranges, split oversized ranges.
  ranges.sort((a, b) => a.startIndex - b.startIndex);
  const merged = mergeSmall(ranges);
  const finalChunks = [];
  for (const r of merged) {
    const text = source.slice(r.startIndex, r.endIndex);
    if (text.length <= MAX_CHARS) {
      finalChunks.push(makeChunk(filePath, lang.name, source, r.startIndex, r.endIndex));
    } else {
      // Split oversized chunks by lines with overlap.
      const startLine = lineOf(source, r.startIndex);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += WINDOW_LINES - OVERLAP_LINES) {
        const slice = lines.slice(i, i + WINDOW_LINES).join("\n");
        if (slice.length < MIN_CHARS && i > 0) break;
        finalChunks.push({
          path: filePath,
          language: lang.name,
          startLine: startLine + i,
          endLine: startLine + Math.min(i + WINDOW_LINES, lines.length) - 1,
          content: slice,
        });
      }
    }
  }
  return finalChunks.filter((c) => c.content.trim().length >= MIN_CHARS);
}

function collectRanges(node, out) {
  for (const child of node.namedChildren) {
    if (CHUNKABLE_NODES.has(child.type)) {
      out.push({ startIndex: child.startIndex, endIndex: child.endIndex });
    } else if (child.type === "export_statement" || child.type === "decorated_definition") {
      // Recurse: e.g. `export class Foo {}` — capture inner.
      collectRanges(child, out);
      out.push({ startIndex: child.startIndex, endIndex: child.endIndex });
    }
  }
}

function mergeSmall(ranges) {
  const out = [];
  let cur = null;
  for (const r of ranges) {
    if (!cur) { cur = { ...r }; continue; }
    const curLen = cur.endIndex - cur.startIndex;
    const nextLen = r.endIndex - r.startIndex;
    const gap = r.startIndex - cur.endIndex;
    if (curLen < TARGET_CHARS && nextLen < TARGET_CHARS && gap < 200 && (curLen + nextLen + gap) <= MAX_CHARS) {
      cur.endIndex = r.endIndex;
    } else {
      out.push(cur);
      cur = { ...r };
    }
  }
  if (cur) out.push(cur);
  return out;
}

function makeChunk(filePath, language, source, startIndex, endIndex) {
  const startLine = lineOf(source, startIndex);
  const endLine = lineOf(source, endIndex - 1);
  return {
    path: filePath,
    language,
    startLine,
    endLine,
    content: source.slice(startIndex, endIndex),
  };
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function windowChunks(filePath, language, source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += WINDOW_LINES - OVERLAP_LINES) {
    const slice = lines.slice(i, i + WINDOW_LINES).join("\n");
    if (slice.trim().length < MIN_CHARS) {
      if (i === 0) {
        // Whole file is short — emit anyway if non-trivial.
        if (slice.trim().length > 0) {
          out.push({ path: filePath, language, startLine: 1, endLine: lines.length, content: slice });
        }
        return out;
      }
      break;
    }
    out.push({
      path: filePath,
      language,
      startLine: i + 1,
      endLine: Math.min(i + WINDOW_LINES, lines.length),
      content: slice,
    });
  }
  return out;
}
