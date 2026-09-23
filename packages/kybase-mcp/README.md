# kybase-mcp

Persistent memory for AI agents, as a single command:

```bash
npx kybase-mcp
```

No Docker, no database to install, no server to run. The first start
creates a local knowledge base under `~/.kybase` and speaks MCP over
stdio. Your notes are plain Markdown in Postgres — running on your
machine, leaving it only if you choose a cloud embedding provider.

This is the same MCP server the full [Kybase](https://github.com/Kyrzin/kybase)
app exposes over HTTP. Use this package when you want memory for a local
agent; use the full app when you also want the web UI, the knowledge
graph view, sharing, and access for several agents at once.

## Connect an agent

**Claude Code** — `.mcp.json` in your project, or `claude mcp add`:

```json
{
  "mcpServers": {
    "kybase": {
      "command": "npx",
      "args": ["-y", "kybase-mcp"]
    }
  }
}
```

**Claude Desktop** — the same block in `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`).

**Cursor** — the same block in `.cursor/mcp.json` or `~/.cursor/mcp.json`.

Several clients on one machine can use it at once: the first process to
start owns the database, and the others connect to that process.

Restart the client and ask it to remember something. It gets 18 tools for
reading, searching, writing, and linking notes.

**Claude Desktop, one click** — download `kybase-mcp-<version>.mcpb` from
[Releases](https://github.com/Kyrzin/kybase/releases) and open it; the
data folder and embedding provider are set in the extension's settings.

The server is listed in the official MCP Registry as
`io.github.Kyrzin/kybase`.

## Search

Full-text search works immediately, in English and Russian, accent- and
case-insensitive.

Semantic search — finding a note by meaning when it shares no words with
your question — needs an embedding provider. The local option is
[Ollama](https://ollama.com):

```bash
ollama pull embeddinggemma
OLLAMA_URL=http://localhost:11434 npx kybase-mcp
```

Existing notes are embedded in the background as soon as a provider is
available; `indexing_status` reports progress. Without one, nothing
breaks — semantic search simply stays idle.

## Reading your notes

The embedded database is not a folder of `.md` files, so this writes the
whole vault out as one:

```bash
kybase-mcp export vault.zip
```

Plain Markdown with frontmatter, folders as directories, `[[wikilinks]]`
intact — open it in any editor. It is also exactly the archive the full
Kybase app accepts under **Settings → Import .zip**, so starting here and
moving to the web UI later costs one command in each direction.

## Configuration

Every variable is optional.

| Variable | Default | What it does |
|----------|---------|--------------|
| `KYBASE_DATA_DIR` | `~/.kybase` | Where the database and instance secret live. |
| `DATABASE_URL` | *(unset)* | Point at an existing Kybase Postgres instead of the embedded one. In this mode the package does not run migrations — the app that owns the schema does. |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama`, `google`, or `openai`. |
| `OLLAMA_URL` | *(unset)* | e.g. `http://localhost:11434`. Enables semantic search. |
| `OLLAMA_MODEL` | `embeddinggemma` | Multilingual by default; `nomic-embed-text` is smaller and English-leaning. |
| `GOOGLE_API_KEY` / `OPENAI_API_KEY` | *(unset)* | Cloud embedding providers. Picking one sends your note text to that provider. |

## Build from source

The package bundles code from the main repository, so build it from a
checkout rather than from this directory alone:

```bash
git clone https://github.com/Kyrzin/kybase.git
cd kybase/packages/kybase-mcp
npm install          # also builds, via the prepare script
npm install -g .     # puts `kybase-mcp` on your PATH
```

## Your data

Everything is under `KYBASE_DATA_DIR`:

- `pgdata/` — the database itself (Postgres compiled to WebAssembly, with
  pgvector). Copy the directory to back it up.
- `secret` — generated on first run, `0600`. It encrypts any embedding
  provider API keys you store. Keep it with the data.
- `run/` — the unix socket the database listens on, in a `0700` directory.
  It has no password, so file permissions are the access control. Windows
  cannot listen on a socket path, so there the database binds an unused
  loopback port instead — reachable by other processes running as you, and
  never from another machine. `KYBASE_EMBEDDED_TCP=1` forces that mode on
  Unix too, for a data directory on a filesystem that cannot host a socket.

Expect the process to hold a few hundred MB of memory while it runs: the
embedded database is a full Postgres, and it lives inside it. Pointing
`DATABASE_URL` at a Postgres you already run avoids that entirely.

Note content is plain Markdown and every note is readable through the MCP
tools, so an agent can always read the whole vault back out, and
`kybase-mcp export` writes it out as files — see
[Reading your notes](#reading-your-notes).

## License

[AGPL-3.0-only](https://github.com/Kyrzin/kybase/blob/main/LICENSE).
