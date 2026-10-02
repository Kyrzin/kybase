# Changelog

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
