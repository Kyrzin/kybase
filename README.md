<p align="center">
  <img src="public/readme/hero.svg" width="100%" alt="Kybase — self-hosted memory for AI agents: a markdown knowledge base you read and edit, and your agent never forgets. Next.js, PostgreSQL + pgvector, Ollama, MCP, one docker compose up.">
</p>

<p align="center">
  <a href="https://github.com/Kyrzin/kybase/actions/workflows/ci.yml"><img src="https://github.com/Kyrzin/kybase/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Kyrzin/kybase/releases"><img src="https://img.shields.io/github/v/release/Kyrzin/kybase" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-8B5CF6" alt="MCP: Streamable HTTP">
  <img src="https://img.shields.io/badge/private-by%20default-success" alt="private by default">
</p>

**Kybase is self-hosted, long-term memory for AI agents.** Any
MCP-speaking agent — Claude, Cursor, Windsurf — can search, read, and
update a persistent Markdown knowledge base through MCP, while **you**
keep full control in the browser: read every note, edit anything, revoke
access anytime. Hybrid search finds the right note, section-level reads
avoid loading entire documents into context, and `[[wikilinks]]` keep the
knowledge connected as it grows.

PostgreSQL + pgvector + Ollama, one `docker compose up`. **No SaaS, no
accounts, private by default** — cloud embeddings (Google, OpenAI) are
optional, not required (see [Switching Embedding
Providers](#switching-embedding-providers) for the trade-off).

<p align="center">
  <img src="public/readme/screenshot.png" width="100%" alt="Kybase UI: a markdown note with wikilinks and tags on the left, the folder tree beside it, and an interactive knowledge graph (17 notes, 76 edges) with wikilink and semantic edges on the right.">
</p>

**[Why Kybase?](#why-kybase) · [How agents use it](#how-agents-use-it) · [Quick Start](#quick-start-docker) · [Environment variables](#environment-variables) · [Connect an MCP Client](#connect-an-mcp-client) · [Stack](#stack) · [Switching Embedding Providers](#switching-embedding-providers) · [Export & Import](#export--import) · [Sharing](#sharing-notes) · [Backups](#backups) · [Upgrading](#upgrading) · [Local development](#local-development) · [More documentation](#more-documentation) · [License](#license)**

## Why Kybase?

Giving an agent persistent memory usually means assembling it yourself:
a notes app, an MCP bridge, an embedding pipeline, and sync between them.
Kybase is that whole stack as one `docker compose up`:

- **Markdown, not an opaque memory blob** — every note is a plain `.md`
  file with frontmatter; read it, edit it, `grep` it, back it up with `cp`
- **MCP-native reads and writes** — an agent searches, reads, and updates
  notes directly through MCP tools, not through a side-channel it can't use
- **Hybrid search** — full-text and semantic search fused into one ranked
  result, so an agent finds the right note whether it knows the exact
  wording or not
- **Section-level reads and writes** — an agent reads or edits the part
  of a note it actually needs, not the whole file
- **Backlinks and a knowledge graph** — `[[wikilinks]]` connect related
  notes automatically; explicit and semantic edges are both visible in
  the graph view
- **Self-hosted, private by default** — your own Postgres, your own
  Ollama; nothing leaves your machine unless you opt into a cloud
  embedding provider

## How agents use it

```text
search_notes("deployment steps for staging")
  → hit includes section: "Rollback"
  → get_note(section: "Rollback")
  → agent reads just that section, not the whole note
  → append_to_note(section: "Rollback", text: "...")
```

Search returns which section of a note matched, not just which note. For
a long note, reading one section instead of the whole file can mean
reading a fraction of the content — cheaper for every step after the
first search, and it's how the agent writes back too.

## Quick Start (Docker)

```bash
git clone https://github.com/Kyrzin/kybase.git
cd kybase
cp .env.example .env
sed -i.bak "s/^KYBASE_SECRET=$/KYBASE_SECRET=$(openssl rand -hex 32)/" .env
sed -i.bak "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
rm -f .env.bak
docker compose pull && docker compose up -d
```

That generates both required secrets in place (the `sed -i.bak` form
works on both Linux and macOS) — nothing else in `.env` needs to change
to get started.

This pulls the prebuilt multi-arch image
([`ghcr.io/kyrzin/kybase`](https://github.com/Kyrzin/kybase/pkgs/container/kybase),
linux/amd64 + linux/arm64) from GitHub Packages, tagged `latest`. To build from
source instead, run `docker compose up -d --build`.

Open http://localhost:3000 and log in with your `KYBASE_SECRET` — then
jump to [Connect an MCP Client](#connect-an-mcp-client) to point an agent
at it.

That's it. On startup the app applies `db/migrations/*.sql` automatically
(tracked in the `schema_migrations` table) and Ollama downloads the
embedding model (embeddinggemma, ~620 MB, one time).
Change the host port with `KYBASE_PORT` in `.env`.

> [!NOTE]
> Notes and text search work immediately. Semantic search and semantic graph
> edges activate once Ollama finishes pulling the model and notes get indexed
> (automatic, in the background).

### Environment variables

Everything below goes in `.env` (copied from `.env.example`). `KYBASE_SECRET` and `POSTGRES_PASSWORD` are required — the rest have working defaults.

| Variable | Default | Notes |
|----------|---------|-------|
| `KYBASE_SECRET` | *(required)* | UI login password and MCP/API bearer token. Generate with `openssl rand -hex 32`. |
| `KYBASE_OAUTH_REDIRECT_URIS` | claude.ai's connector callback | Comma-separated extra OAuth `redirect_uri` values, matched in full — give the whole URL, not just a host. Loopback addresses are always allowed. Only relevant if an MCP client does its own hosted OAuth instead of a static Bearer token. |
| `KYBASE_PORT` | `3000` | Host port the app is exposed on. |
| `POSTGRES_PASSWORD` | *(required)* | Postgres is only reachable inside the compose network, but `docker compose up` refuses to start without one — no silent weak default. Generate with `openssl rand -hex 16`. |
| `KYBASE_TAG` | `latest` | Prebuilt image tag from `ghcr.io/kyrzin/kybase`. `latest` always tracks the newest [release](https://github.com/Kyrzin/kybase/releases) tag; pin to a specific version (e.g. `v1.3.0`) if you want upgrades to be a deliberate step. |
| `EMBEDDING_PROVIDER` | `ollama` | `ollama`, `google`, or `openai` — see [Switching Embedding Providers](#switching-embedding-providers). |
| `OLLAMA_URL` | `http://ollama:11434` | Point at an external Ollama instance instead of the bundled container. |
| `OLLAMA_MODEL` | `embeddinggemma` | Or `nomic-embed-text`. |
| `GOOGLE_API_KEY` / `GOOGLE_MODEL` | *(empty)* / `text-embedding-004` | Only used when `EMBEDDING_PROVIDER=google`. |
| `OPENAI_API_KEY` | *(empty)* | Only used when `EMBEDDING_PROVIDER=openai`. |

`DATABASE_URL` isn't something you set for the Docker path — compose derives it from `POSTGRES_PASSWORD` automatically. It's only relevant for [local development](#local-development) running the app directly on the host.

## Connect an MCP Client

The app exposes a Streamable HTTP MCP endpoint at `/api/mcp`. Any MCP client that speaks Streamable HTTP can connect — not just Claude.

**Claude Code** — add to `.mcp.json` (or `claude mcp add`):

```json
{
  "mcpServers": {
    "kybase": {
      "type": "http",
      "url": "https://your-domain/api/mcp",
      "headers": {
        "Authorization": "Bearer <KYBASE_SECRET>"
      }
    }
  }
}
```

**Claude Desktop** — same JSON shape, in `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`).

**claude.ai** — Settings → Connectors → Add custom connector, same URL
(requires the instance to be reachable over HTTPS). No key to paste: the
connector registers itself (RFC 7591), sends you to your own instance to enter
the key once, and gets its own revocable OAuth token — see **Settings →
Connected clients** in the web UI. A connector can only be sent back to a
callback this server accepts, so registration cannot point one somewhere else.

**Cursor** — add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "kybase": {
      "url": "https://your-domain/api/mcp",
      "headers": {
        "Authorization": "Bearer <KYBASE_SECRET>"
      }
    }
  }
}
```

**Windsurf** — add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "kybase": {
      "serverUrl": "https://your-domain/api/mcp",
      "headers": {
        "Authorization": "Bearer <KYBASE_SECRET>"
      }
    }
  }
}
```

### MCP tools (17)

| Tool | Category | What it does for the agent |
|------|----------|------------------------------|
| `search_notes` | Search | Hybrid RRF search (pgvector + bilingual FTS); `exact` flags a literal substring match, `matched_by` shows which arms found it, `section` names which part of a long note matched |
| `get_note` | Read | Fetch a note by id or fuzzy title; windowed for large notes, with a heading outline. `resolve_links:true` also resolves every `[[wikilink]]` inside it, one level deep, in the same round-trip |
| `list_notes` | Read | Newest-first listing, filterable by folder/tag/updated date |
| `list_tags` | Read | All tags in use with counts, so the agent reuses existing tags instead of coining duplicates |
| `list_folders` | Read | Flat folder list for reconstructing the tree |
| `get_backlinks` | Graph | Notes that link to a given note via `[[wikilinks]]` |
| `get_graph` | Graph | The knowledge graph — wikilink edges plus semantic edges — scoped by folder or by hop count from a root note |
| `create_note` | Write | Create a note; embedding is generated automatically in the background |
| `update_note` | Write | Update fields; supports `expected_updated_at` to refuse a stale overwrite instead of silently clobbering a concurrent edit |
| `append_to_note` | Write | Insert text at a note/section boundary (`at`: note/section start or end) without resending the rest — safe under concurrent writers (row-locked) |
| `replace_in_note` | Write | Find-and-replace exact text; refuses unless the match count equals `expected_count`, so a loose `find` can't silently rewrite more than intended |
| `delete_note` | Write | Soft-delete; recoverable with `restore_note` before it ages out of the trash |
| `restore_note` | Write | Undo `delete_note` |
| `create_folder` | Organize | Create a folder, optionally nested |
| `update_folder` | Organize | Rename or move a folder; refuses a move that would create a cycle |
| `delete_folder` | Organize | Delete a folder and its subtree; every note inside is soft-deleted along with it |
| `indexing_status` | Diagnostics | How many notes are embedded vs. still pending, to tell "still indexing" from "done" |

The server ships with MCP instructions that teach the agent to search before
writing and to add `[[wikilinks]]` to related notes — so the knowledge graph
grows as the agent uses it, instead of accumulating orphan notes.

**How search works, in plain terms.** `search_notes` has three modes:
`text` (exact words, filenames, identifiers), `semantic` (meaning, via
embeddings), and `hybrid` (both, fused into one ranked list — the
default, and usually the right choice). A few fields on each hit mean
something narrower than they sound:

- `exact: true` means the query is a literal, contiguous substring of
  the note — good for finding a specific compound identifier or
  filename, not a signal that "this is the right answer."
- `relevance` ranks hits within this one response, relative to its own
  best hit — it's not a confidence score or a probability.
- A hit found only by the semantic arm means "similar topic," not
  "confirms this fact." Read the excerpt before trusting it.
- `unprofiled` (reported by `indexing_status`) means semantic search
  still works on that embedding model, but nothing is guaranteed to be
  rejected as "not close enough" — the automatic cutoff needs a model
  Kybase has measured, or one you configure yourself (see [Switching
  Embedding Providers](#switching-embedding-providers)).

When a hit's `section` is set, `get_note(section:)` reads just that part
instead of the whole note.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js App Router, React 19 |
| Database | PostgreSQL 16 + pgvector (direct `pg` connection) |
| Embeddings | Ollama `embeddinggemma` (default, multilingual) / Google / OpenAI |
| Search | RRF hybrid: pgvector HNSW cosine + bilingual FTS |
| MCP | `@modelcontextprotocol/sdk` Streamable HTTP |
| Auth | `KYBASE_SECRET` env var + revocable per-client OAuth tokens (MCP) |

---

## Switching Embedding Providers

You can switch the embedding provider (between local Ollama, Google, or OpenAI) and trigger re-indexing directly in the browser:

1. Open the settings modal in the web UI.
2. Select your provider, add the API key if needed, and click **Save & Apply** (switching the provider automatically re-indexes every note).
3. **Reindex** only catches notes that were never embedded. After anything else that changes how embeddings are computed (e.g. an update to the embedding logic itself), use **Reindex all** to force-recompute every note.

All supported providers use 768-dimensional embeddings, so switching does not require any database schema changes.

> [!IMPORTANT]
> Ollama keeps everything on your machine — no note content leaves it. Google
> and OpenAI are convenience options: picking either sends your notes' full
> text to that provider's API to compute the embedding.

**Local model choice.** The default local model is `embeddinggemma`
(multilingual) — for multilingual vaults (e.g. Russian/German) it
separates relevant from irrelevant notes far better than English-centric
models. `nomic-embed-text` is a smaller, English-leaning alternative.

Supported embedding models include sensible built-in defaults for
semantic search. Unprofiled models still support semantic search, but
Kybase does not automatically reject weak semantic matches unless a
threshold is configured — `indexing_status` reports whether the active
model is profiled. See `lib/embeddings.ts` for the details and how to
configure a threshold yourself.

> [!TIP]
> **Already run Ollama?** On a host that already has an Ollama instance (e.g. a
> GPU one), skip the bundled CPU container: set `OLLAMA_URL` in `.env` to your
> instance (pull `OLLAMA_MODEL` there first) and start with the override file —
> `docker compose -f docker-compose.yml -f docker-compose.external-ollama.yml up -d`.

> [!TIP]
> **CLI alternative.** If you prefer using the terminal, you can trigger re-indexing by calling the admin endpoint — only pending notes by default, add `?mode=all` to the URL to force every note instead:
> ```bash
> docker compose exec kybase node -e "
>   fetch('http://localhost:3000/api/admin/reindex', {
>     method: 'POST',
>     headers: { Authorization: 'Bearer <KYBASE_SECRET>' }
>   }).then(r => r.json()).then(console.log)
> "
> ```

---

## Export & Import

Your notes are never locked in. Settings → **Export .zip** downloads the
whole vault as plain markdown files with frontmatter (title, tags, created/
updated dates), folders as directories — readable by any editor, Obsidian
included. **Import .zip** merges a vault back; notes whose titles already
exist are skipped. A new note's creation date is restored from the file;
its "last updated" timestamp is set to the moment it lands back in the
vault rather than carried over — that field tracks when this server last
changed the row, so a re-imported note showing up as recently touched is
correct, not a bug. Imported notes are re-embedded automatically in the
background.

The same via API:

```bash
curl -H "Authorization: Bearer <KYBASE_SECRET>" -o vault.zip \
  http://localhost:3000/api/export

# mode=skip (default) keeps existing notes; mode=overwrite replaces them
curl -X POST -H "Authorization: Bearer <KYBASE_SECRET>" \
  --data-binary @vault.zip \
  "http://localhost:3000/api/import?mode=skip"
```

---

## Sharing notes

The **Share** button on a note creates a public read-only link
(`/share/<token>`) — rendered markdown, no login, wikilinks shown as plain
text so nothing else in your vault is reachable. The threat model in one
sentence: **the link is the access — revoke links you no longer need**
(Settings → Active share links shows everything that is currently public).

---

## Backups

Everything lives in one Postgres volume — a nightly `pg_dump` is one line.
Full recipe including cron and restore: [docs/backup.md](docs/backup.md).

---

## Upgrading

```bash
# prebuilt image
docker compose pull && docker compose up -d

# or rebuild from source
git pull && docker compose up -d --build
```

Migrations apply automatically on startup. Details: [docs/upgrading.md](docs/upgrading.md).

---

## Local development

```bash
# Postgres only (app runs on the host)
docker compose up -d db
cp .env.example .env.local
# in .env.local: set KYBASE_SECRET and uncomment DATABASE_URL
npm install
npm run dev                  # http://localhost:3000

npm run build     # Production build check
npx tsc --noEmit  # Type check
```

---

## More documentation

[SECURITY.md](SECURITY.md) (threat model, what's implemented) ·
[CONTRIBUTING.md](CONTRIBUTING.md) · [docs/backup.md](docs/backup.md) ·
[docs/upgrading.md](docs/upgrading.md)

---

## License

[AGPL-3.0](LICENSE) — free to use, modify, and self-host. If you run a
modified version as a network service, you must make its source available
to your users under the same license.

For a commercial license (e.g. embedding Kybase in a closed-source product
or service), contact the author.

Copyright © Denis Kurzin (https://github.com/Kyrzin)
