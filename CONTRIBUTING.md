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
- If you touch `lib/mcp-server.ts`, update the tool count/table in `README.md` and re-check the MCP tool descriptions the agent sees.
- Migrations go in `db/migrations/` as a new numbered `.sql` file — never edit an already-released one.

## Reporting bugs / requesting features

Use the issue templates (`.github/ISSUE_TEMPLATE/`) — they ask for the fields that make a report actionable.
