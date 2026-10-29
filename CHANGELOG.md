# Changelog

## Kybase 1.5.3

### Security
- Updated Next.js, markdown-it and other dependencies with security fixes.
- New `KYBASE_PUBLIC_URL` setting: the address Kybase names in sign-in
  metadata and share links, instead of one taken from request headers.

### Import
- Removing scripts and styles from imported HTML, EPUB and DOCX no longer
  drops text next to a tag inside a comment.

### Install
- The shipped compose file has a healthcheck for the app.

## Kybase 1.5.2

### Security
- Fixed unsafe rendering of crafted note content in the web UI.
- Shared notes get their own, stricter content security policy.
- The Google API key is sent in a request header instead of the URL.

### Notes
- Notes render with markdown-it: inline code, links with parentheses,
  nested lists and quotes show as written.
- Typing is no longer lost when an import or a new note opens, and a save
  refused while the tab was hidden is reported instead of dropped.

### Search
- More accurate reranking of short sections and of notes kept as logs.
- `search_notes` names other matching sections of the same note
  (`other_sections`), so an agent can read later entries too.
- The log says when the reranker stops or starts answering.

### Install
- The shipped compose file publishes the app on this machine only. Set
  `KYBASE_BIND=0.0.0.0` to reach it from other devices; see Upgrading.
- A provider key saved under another `KYBASE_SECRET` is reported once in
  the log, not on every search.

### Connections
- Setup for Devin Desktop (formerly Windsurf) in the README and in
  Settings → Connect.
- The MCP server reports the Kybase version.
- The hint shown when Ollama is not running fits every install.
- Sign-in pages call the master secret the secret.

## Kybase 1.5.1

### Search
- Better results for names, rare words and short queries.
- Better passages and excerpts from long notes, shown under the right section.
  Run Reindex in Settings to apply this to existing notes.
- Optional reranker: new `KYBASE_RERANK_MODE` setting, default `rank`;
  `replace` keeps the previous behaviour. The first search after a restart is
  reranked too.
- `search_notes` marks weak matches and reports results removed by the minimum
  reranker score.
- `explain` reports `rrf_score` under its own name.

### Graph
- New graph view with folders as islands. Needs WebGL.

### Connections
- ChatGPT can connect without configuration.
- `KYBASE_OAUTH_REDIRECT_URIS` is passed through the shipped compose file.
- Refused OAuth callback URIs are logged.

## Kybase 1.5.0

### Search
- Hybrid search now orders results with a signal arbiter by default. A keyword
  match on only part of a query no longer outranks a strong meaning-based match,
  and verbatim identifiers (filenames, hostnames, IDs) still come first.
  `KYBASE_SEARCH_FUSION=legacy` or `rrf` restores a previous ordering;
  `KYBASE_ARBITER_SEM_THRESHOLD` sets how strong a semantic match must be to lead.
- `search_notes` takes `note_id` to search inside one note: a long document
  returns several places, each with its own excerpt, section and offset.
- With a reranker, the passage closest to the question in meaning is considered
  too, so a question asked in other words or another language is judged on the
  right part of a note.

### Notes and history
- Every change to a note keeps the previous version, labelled with where it came
  from: the web app, the REST API, an import, or an MCP client by name. The
  History panel shows a line diff and can restore or delete a version; the
  Changes panel lists recent edits across the vault.
- The editor no longer loses or misplaces unsaved text when the open note is
  re-selected, its tags or folder change, a PDF is imported, or nothing changed.
- The open note refreshes when you return to the tab, picking up edits an agent
  made meanwhile.
- The web app loads a lightweight note list and fetches each note's text when it
  is opened, instead of loading the whole vault.

### Agents and API
- Settings connects Claude Code, Claude Desktop and Cursor over OAuth: each signs
  in once and gets its own revocable token. The instance secret still works.
- OAuth client registration keeps the usable redirect URIs of a client instead of
  refusing the whole registration over one it cannot use.
- `GET /api/notes?content=false` returns the list without note text, `?q=`
  searches it; new `GET /api/notes/{id}/backlinks` and `GET /api/graph/links`.
- `POST /api/notes` accepts `folder_path`; an unknown path is rejected with 400.

### Import
- Archive import keeps files whose titles repeat (the later one becomes
  "Title (Folder)") and reports which files were renamed or skipped.

### Under the hood
- Search, the MCP server and embedding providers are split into smaller modules
  with no change in behaviour.

### Upgrading
- Migrations apply automatically on start; there are no breaking configuration
  changes.
- The repository history was reset to a single commit. Existing clones should run
  `git fetch origin && git reset --hard origin/main`, or clone again. Docker
  images and the npm package are not affected.

## kybase-mcp 0.2.2

- Includes the Kybase 1.5.0 search ordering (signal arbiter) and `note_id` for
  searching inside one note.
- Note changes made through the package are kept as revisions, labelled with the
  MCP client's name.
