# Contributing to Kybase

## Dev setup

```bash
docker compose up -d db      # Postgres only, app runs on the host
cp .env.example .env.local
# in .env.local: set KYBASE_SECRET and uncomment DATABASE_URL
npm install
npm run dev                  # http://localhost:3000
```

## Before opening a PR

CI runs these on every push and PR — matching them locally first saves a round-trip:

```bash
npx tsc --noEmit                    # type check
npm run lint -- --max-warnings 0    # lint
npm run build                       # production build check
```

CI also runs a full `docker compose` smoke test (build the image, create a
note over MCP, search for it, export the vault) on pushes to `main` and on
release tags — not on plain PRs, to keep PR feedback fast. Run it locally
with `docker compose up -d --build && npm run smoke-test` if you're touching
the MCP endpoint, auth, or the compose/Dockerfile setup.

## PR expectations

- Keep changes focused — a bug fix doesn't need surrounding refactors.
- If you touch `lib/mcp-server.ts`, update the tool count/table in `README.md` and re-check the MCP tool descriptions the agent sees. The same file ships inside the `kybase-mcp` npm package (`packages/kybase-mcp`), so rebuild it there (`npm install && node build.mjs`) if you change what it exposes.
- Migrations go in `db/migrations/` as a new numbered `.sql` file — never edit an already-released one.

## Reporting bugs / requesting features

Use the issue templates (`.github/ISSUE_TEMPLATE/`) — they ask for the fields that make a report actionable.

## Licensing of contributions

Kybase is [AGPL-3.0-only](LICENSE), and contributions join the project
under that same license.

By opening a pull request you confirm two things: that the work is yours
to contribute, and that you agree the project may also be released under
other terms in future — a more permissive license, or a commercial license
offered alongside the AGPL.

That second point is here to keep the option open rather than to exercise
it. Changing a project's license needs the agreement of everyone who holds
copyright in it, and chasing down past contributors years after the fact is
how projects end up unable to change course at all.
