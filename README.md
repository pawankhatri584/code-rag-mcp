# code-rag-mcp

[![npm version](https://img.shields.io/npm/v/code-rag-mcp.svg)](https://www.npmjs.com/package/code-rag-mcp)
[![npm downloads](https://img.shields.io/npm/dm/code-rag-mcp.svg)](https://www.npmjs.com/package/code-rag-mcp)
[![license](https://img.shields.io/npm/l/code-rag-mcp.svg)](./LICENSE)

Repo-local semantic code search over [MCP](https://modelcontextprotocol.io). Tree-sitter chunking + [jina-embeddings-v2-base-code](https://huggingface.co/jinaai/jina-embeddings-v2-base-code) + LanceDB. One command to install.

When you use Claude Code (or any MCP-aware assistant) with this server loaded, intent-based queries like *"where do we handle JWT refresh"* or *"auth race condition fix"* return ranked code snippets — not just files that literally contain the words.

## Install

```bash
cd your-repo
npx code-rag-mcp init
```

No global install needed — `npx` fetches and caches the package on first run. To pin a specific version, use `npx code-rag-mcp@0.1.0 init`.

That's it. `init` will:

1. Detect the repo root (nearest `.git` ancestor, or cwd).
2. Register an MCP entry in `.mcp.json` at the repo root.
3. Kick off the first index in a background process (logs stream to `~/.cache/code-rag/<repo-hash>/index.log`).
4. Print next steps.

Then restart Claude Code (or reload MCP servers) — the `code-rag` tools will appear.

## What it gives you

Three MCP tools:

| Tool | Purpose |
|------|---------|
| `code_search` | Semantic search. Args: `query` (required), `k` (default 10, max 50), `language` filter, `path_glob` filter. Returns ranked snippets with `path:start-end` IDs. |
| `get_chunk` | Fetch the full content of a single chunk by ID (for follow-up reads after a truncated `code_search` result). |
| `index_stats` | Row count, file count, language distribution. |

## Stack

- **Chunking**: tree-sitter at function / class / method / interface boundaries. Languages: TypeScript, TSX, JavaScript (+ JSX/MJS/CJS), Rust, Python. Line-window fallback for JSON, Markdown, HTML, CSS, shell, YAML, TOML, SQL, plain text.
- **Embeddings**: `jinaai/jina-embeddings-v2-base-code` via `@huggingface/transformers`. 768-dim, code-tuned, ONNX + q8 quantization on CPU.
- **Vector store**: LanceDB (embedded, on-disk).
- **Transport**: MCP stdio.

## Commands

```bash
code-rag init             # Register in this repo's .mcp.json and start indexing
code-rag init --personal  # Register in .claude/settings.local.json instead (gitignored)
code-rag init --force     # Overwrite an existing code-rag entry
code-rag serve            # Run the MCP stdio server (what Claude Code invokes)
code-rag reindex          # Re-scan the repo; only re-embeds changed files
code-rag reindex --force  # Rebuild every file from scratch
code-rag stats            # Print files / chunks / language distribution
code-rag help
```

## How it knows which repo to index

At runtime, the server resolves:

- `REPO_ROOT` — from env var, else walk up from `cwd` until a `.git` directory is found.
- `DATA_DIR` — from env var, else `~/.cache/code-rag/<sha256(repoRoot).slice(0,16)>/`.

This means one `code-rag-mcp` install can serve many repos — each gets its own isolated index keyed by absolute path. The `.mcp.json` entry written by `init` contains no user-specific paths, so you can commit it and teammates just `npm install` and restart Claude Code.

## What's excluded from indexing

Built-in skips (on top of your repo's `.gitignore`):

```
node_modules/  .git/  dist/  build/  out/  target/  .next/  .nuxt/
.turbo/  .cache/  .vercel/  coverage/  *.lock  package-lock.json
yarn.lock  pnpm-lock.yaml  *.generated.{ts,js}  *.min.{js,css}
```

If `DATA_DIR` falls inside your repo, the indexer also excludes itself (so the index doesn't index the index).

## First-run cost

- **Model download**: ~320 MB one-time download of the jina embeddings model to `~/.cache/huggingface/`. Shared across all repos that use this tool.
- **Indexing**: ~10–15 minutes for a ~1,500-file repo on CPU (embeddings dominate). Subsequent `reindex` runs only re-embed files whose mtime changed.

## Why not just grep?

Grep returns a file list. You read the files to figure out which one actually matters. That's fine for literal strings (symbol names, error messages, config keys) but loses to semantic search on questions like:

- *"where is the race condition fix for auth?"* — the code says `authState` and `TOCTOU`, not "race condition"
- *"how does the popout window talk to the taskpane?"* — the code says `BroadcastChannel` / `Office.Dialog`, not "talk to"
- *"find the OAuth registry"* — the code has a `const OAUTH_CONNECTORS = [...]` array; `grep "registry"` misses it

code-rag ranks by distance (lower = closer), returns snippet previews inline, and handles intent well even when the matching code uses none of your query's words.

Keep using grep for exact literal matches — that's what it's best at.

## Requirements

- Node.js ≥ 18.17
- ~500 MB disk for the model cache (first run only, shared across repos)
- ~50–200 MB per indexed repo (depends on repo size)
- Native build toolchain for `tree-sitter` on first install (Xcode CLT / build-essential / Visual Studio Build Tools)

## Troubleshooting

**`tree-sitter` fails to build on Windows** — install Visual Studio Build Tools with the "Desktop development with C++" workload, then `npm install` again.

**Model download is slow or blocked** — set `HF_ENDPOINT` to a mirror, or pre-download to `~/.cache/huggingface/`.

**The tool doesn't show up in Claude Code** — restart Claude Code after `init`. Confirm the entry landed in `.mcp.json` at the repo root (not a parent dir). Run `code-rag stats` from the same `cwd` to verify the index exists.

**"No matches" for queries you expect to hit** — run `code-rag stats` to confirm the index isn't empty. If it's 0 chunks, re-run `code-rag reindex`. If your files aren't one of the indexed extensions, they're skipped by design.

## License

MIT
