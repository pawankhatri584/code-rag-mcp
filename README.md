# code-rag-mcp

[![npm](https://img.shields.io/npm/v/code-rag-mcp?label=npm&color=cb3837)](https://www.npmjs.com/package/code-rag-mcp)
[![license](https://img.shields.io/npm/l/code-rag-mcp?color=green)](./LICENSE)
[![node](https://img.shields.io/node/v/code-rag-mcp)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed)](https://modelcontextprotocol.io)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97706)](#claude-code-plugin)

> The **lightweight** repo-local code-RAG for Claude Code. **No Docker. No Ollama. No external DB. No API keys.** Just one npm command.

`npx code-rag-mcp init` — 30 seconds to running. Hybrid semantic + keyword search across 11 languages, a live file watcher that keeps your index fresh, and an embedded vector store. The whole package is ~15 KB of code and pulls Node-native deps only.

```bash
cd your-repo
npx code-rag-mcp init
```

Restart Claude Code, ask *"where do we handle JWT refresh?"* or *"auth race condition fix"* — get ranked code snippets back, not a file list.

---

## Why lightweight?

Most code-RAG tools want you to run Docker, install Ollama, spin up Qdrant/Milvus/Postgres, manage a separate index service, or mint API tokens. That's friction for a tool you invoke 50 times a day.

**`code-rag-mcp` runs as a single Node.js process spawned by Claude Code itself.** Nothing else to manage. Nothing else to remember to start. Nothing to uninstall when you're done.

| What you need | code-rag-mcp | Typical competitor |
|---|---|---|
| Docker | No | Usually |
| Ollama / external LLM server | No | Often |
| External vector DB (Qdrant, Milvus, Weaviate) | No — embedded LanceDB | Often |
| API keys | No | Sometimes |
| A running background service | Claude Code spawns it | Usually yes |
| Manual reindex on file save | No — built-in watcher | Often |
| Config file editing | No — `init` handles it | Usually |

Everything stays on your machine. No telemetry, no cloud, no network calls at query time. The only network call is the one-time embeddings model download from Hugging Face (~320 MB, cached).

## Headline features

- **Hybrid search** — semantic (vector) + keyword signals fused via Reciprocal Rank Fusion. Beats pure vector for identifier lookups, beats pure grep for intent-based queries.
- **Live index** — chokidar-backed file watcher re-embeds changed files in the background, with debounce. You never think about staleness.
- **Startup catch-up** — when `serve` boots, files changed since last shutdown are re-embeded before the watcher takes over.
- **11 languages via tree-sitter** — TypeScript, TSX, JavaScript (+ JSX/MJS/CJS), Rust, Python, Go, Java, Ruby, C, C++, PHP. Plus line-windowed fallback for Markdown, JSON, SQL, YAML, TOML, HTML, CSS, shell, and more.
- **One command install** — `npx code-rag-mcp init` detects your repo root, writes the MCP entry, kicks off indexing. No global install required.
- **Three install modes** — `npx` (default, zero-install), `--global` (pinned), `--local` (project dep).
- **Claude Code plugin** — install via `claude plugin install pawankhatri584/code-rag-mcp` for one-shot setup.

## Install

```bash
cd your-repo
npx code-rag-mcp init
```

That's it. `init`:
1. Walks up from `cwd` to find the repo root (nearest `.git`).
2. Writes an MCP server entry into `.mcp.json` at the repo root.
3. Computes a repo-scoped data dir at `~/.cache/code-rag/<hash>/` (outside your tree).
4. Kicks off the first index in a background process. Logs stream to `<data-dir>/index.log`.

Restart Claude Code — the `code_search`, `get_chunk`, and `index_stats` tools appear automatically.

### Claude Code plugin

If you're using Claude Code's plugin system, you can skip `init` entirely:

```bash
claude plugin install pawankhatri584/code-rag-mcp
```

The plugin's `plugin.json` manifest registers the MCP server. Restart Claude Code and you're done. Indexing happens on first `serve`.

### Install modes

| Mode | Command | MCP entry | When to use |
|------|---------|-----------|-------------|
| **npx** (default) | `npx code-rag-mcp init` | `npx -y code-rag-mcp serve` | Any repo, any language. Always latest. No install needed. |
| **Global** | `npm i -g code-rag-mcp && code-rag init --global` | `code-rag serve` | Faster cold-start, offline-friendly, pinned version. |
| **Local dep** | `npm i -D code-rag-mcp && npx code-rag-mcp init --local` | `npx code-rag-mcp serve` (from node_modules) | Node projects where you want the version pinned in `package.json` and shared with teammates via `npm ci`. |

Add `--personal` to any of the above to write into `.claude/settings.local.json` (gitignored — per-user) instead of `.mcp.json` (committed — team-wide).

### Requirements

- **Node.js ≥ 18.17** (that's it)
- ~500 MB disk for the embeddings model on first run (shared across all repos you use this on)
- ~50–200 MB per indexed repo (LanceDB + metadata, outside your tree)
- A C/C++ toolchain for `tree-sitter` native compile on first install (Xcode CLT / build-essential / Visual Studio Build Tools)

## MCP tools exposed

| Tool | Purpose |
|------|---------|
| `code_search` | Hybrid (semantic + keyword + RRF) / semantic-only / keyword-only search. Args: `query`, `k` (default 10, max 50), `mode` (`hybrid` default), `language`, `path_glob`. Returns ranked chunks with `path:start-end` IDs. |
| `get_chunk` | Fetch the full content of a single chunk by ID (for follow-up reads after a truncated result). |
| `index_stats` | File count, chunk count, language distribution, index location. |

## How search works (hybrid)

```
           ┌──── query ────┐
           │               │
     ┌─────▼──────┐  ┌─────▼──────┐
     │  embed     │  │  tokenize  │
     │  (jina)    │  │  + dedupe  │
     └─────┬──────┘  └─────┬──────┘
           │               │
     ┌─────▼──────┐  ┌─────▼──────┐
     │ vector     │  │ keyword    │
     │ search     │  │ candidates │
     │ (LanceDB)  │  │ (SQL LIKE) │
     └─────┬──────┘  └─────┬──────┘
           │               │
           └──────┬────────┘
                  │
            ┌─────▼──────┐
            │ RRF fusion │
            │  (k=60)    │
            └─────┬──────┘
                  │
               top-k results
```

**Vector search** finds chunks whose meaning is close to the query — even when the words are different. *"race condition in auth"* finds chunks mentioning `TOCTOU` and `authState` because the embedding model learned those are related.

**Keyword search** finds chunks containing the literal query terms. *"OAUTH_CONNECTORS"* finds the file that declares that constant directly, without relying on vector similarity to rank it.

**Reciprocal Rank Fusion** blends both rankings. A chunk that ranks #3 by vector and #7 by keyword gets fused: `1/(60+3) + 1/(60+7)` ≈ 0.031. Robust, simple, the standard technique from the original RRF paper.

Override with `mode: "semantic"` for pure vector or `mode: "keyword"` for BM25-style exact matching.

## Stack

- **Chunking**: tree-sitter at function / class / method / interface / struct / namespace boundaries. Languages indexed via AST: **TypeScript, TSX, JavaScript (+ JSX/MJS/CJS), Rust, Python, Go, Java, Ruby, C, C++, PHP**. Line-window fallback for: **JSON, Markdown, HTML, CSS/SCSS, shell, YAML, TOML, SQL**, and more.
- **Embeddings**: [`jinaai/jina-embeddings-v2-base-code`](https://huggingface.co/jinaai/jina-embeddings-v2-base-code) — 768-dim, code-tuned, 8192-token context. CPU via ONNX with q8 quantization (3–4× faster than fp32, negligible retrieval-quality loss). No GPU required.
- **Vector store**: [LanceDB](https://lancedb.com) — columnar embedded vector DB. Single file-backed store.
- **Keyword store**: same LanceDB table, queried via SQL `LIKE` over the `content` column. No separate index to maintain.
- **Live watcher**: [chokidar](https://github.com/paulmillr/chokidar) v4 with awaitWriteFinish + 2s debounce.
- **Transport**: MCP stdio.

## Commands

```bash
code-rag init                     # register in .mcp.json and start indexing (npx mode)
code-rag init --global            # use global binary (needs:  npm i -g code-rag-mcp)
code-rag init --local             # use project-local install (needs:  npm i -D code-rag-mcp)
code-rag init --personal          # write to .claude/settings.local.json (gitignored)
code-rag init --force             # overwrite an existing entry

code-rag serve                    # run the MCP stdio server (invoked by Claude Code)
code-rag reindex                  # re-scan the repo; only re-embeds changed files
code-rag reindex --force          # rebuild every file from scratch
code-rag stats                    # files / chunks / language distribution
code-rag help
```

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `REPO_ROOT` | auto (nearest `.git`) | Override repo root |
| `DATA_DIR` | `~/.cache/code-rag/<hash>/` | Override index location |
| `CODE_RAG_WATCH` | `1` | Set `0` to disable the file watcher |
| `CODE_RAG_STARTUP_SCAN` | `1` | Set `0` to skip startup catch-up |
| `CODE_RAG_CHECK_UPDATES` | `0` | Set `1` to log a notice when a newer version is on npm (one-shot network call) |
| `EMBED_DTYPE` | `q8` | Set `fp32` for max quality (slower), `q4` for faster/smaller (some loss) |
| `HF_ENDPOINT` | `huggingface.co` | Mirror for restricted networks |

## What gets excluded from indexing

Built-in skip list (on top of your repo's `.gitignore`):

```
node_modules/  .git/  dist/  build/  out/  target/  .next/  .nuxt/
.turbo/  .cache/  .vercel/  coverage/  *.lock  package-lock.json
yarn.lock  pnpm-lock.yaml  *.generated.{ts,js}  *.min.{js,css}
```

If the data dir happens to land inside your repo, it's also excluded (the index doesn't index itself).

## First-run cost

| Step | Cost | Notes |
|------|------|-------|
| Embeddings model download | ~320 MB, 1–3 min | One-time, cached in `~/.cache/huggingface/`, shared across all repos |
| Initial indexing | ~10–15 min for a 1,500-file repo | CPU-bound on embeddings; scales linearly |
| Subsequent reindex | Seconds — or automatic via watcher | Only changed files are re-embedded |
| Per-query latency | ~100–300 ms | Embedding + vector + keyword + fusion |

## Troubleshooting

<details>
<summary><b>The tool doesn't show up in Claude Code</b></summary>

Restart Claude Code after running `init` — MCP servers are loaded once at startup. Confirm the entry landed in `.mcp.json` at the repo root. Run `code-rag stats` from the same `cwd` to verify the index exists.
</details>

<details>
<summary><b><code>tree-sitter</code> fails to build on install</b></summary>

You're missing a C/C++ toolchain. On macOS, `xcode-select --install`. On Ubuntu/Debian, `sudo apt install build-essential python3`. On Windows, install Visual Studio Build Tools with the "Desktop development with C++" workload, then `npm install` again.
</details>

<details>
<summary><b>Model download is slow / blocked</b></summary>

Set `HF_ENDPOINT` to a mirror (e.g. `https://hf-mirror.com`), or pre-download the model and place it under `~/.cache/huggingface/hub/models--jinaai--jina-embeddings-v2-base-code/`.
</details>

<details>
<summary><b>"No matches" for queries I expect to hit</b></summary>

Run `code-rag stats`. If it reports 0 chunks, the first index hasn't finished or didn't run — run `code-rag reindex`. If your files are in a language not listed above, they're skipped by design.
</details>

<details>
<summary><b>I want the index somewhere else</b></summary>

Set `DATA_DIR` in the MCP entry's env block:

```json
"code-rag": {
  "command": "npx",
  "args": ["-y", "code-rag-mcp", "serve"],
  "env": { "DATA_DIR": "/absolute/path/to/index" }
}
```
</details>

<details>
<summary><b>I'm on a polyglot repo with more languages</b></summary>

Open an issue with the language — adding a parser is ~30 LOC (one `tree-sitter-<lang>` package + a handful of node-type names). We intentionally stay selective (11 languages vs some competitors' 66) to keep the install small and the build fast.
</details>

## Roadmap

- On-disk BM25 index (drop SQL LIKE) for faster keyword search on very large repos
- `find_symbol` tool for definition lookups (name → chunks)
- Git-hook install mode — reindex automatically on `post-commit`
- Parsers for a few more common ecosystems based on issue requests

Issues and PRs welcome. The codebase is ~1,200 lines across 10 files — easy to read through.

## Contributing

```bash
git clone https://github.com/pawankhatri584/code-rag-mcp.git
cd code-rag-mcp
npm install
node src/cli.js help
```

Good first contributions:
- Add a tree-sitter language (see `src/chunker.js` — extend `LANG_BY_EXT` and `CHUNKABLE_NODES`)
- Tune the exclude list for a specific ecosystem
- Add a `code-rag doctor` command

## License

[MIT](./LICENSE)

---

<sub>Built for developers who want Claude Code to understand their codebase the same way they do — without spinning up a stack of services. If this saves you an afternoon of grepping, consider starring the repo.</sub>
