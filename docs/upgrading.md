# Upgrading

```bash
git pull
docker compose up -d --build
```

That's the whole procedure. The rest of this page explains what happens
underneath.

## How migrations work

Pending files from `db/migrations/` are applied automatically when the app
starts (`instrumentation.ts` → `lib/migrate.ts`), before the server accepts
requests:

- Applied migrations are tracked in the `schema_migrations` table.
- An advisory lock prevents concurrently starting instances from racing.
- Each migration file runs inside its own transaction; a failure rolls it
  back and stops the server with a clear error instead of serving requests
  against a half-migrated schema. Keep migration statements
  transaction-safe (no `create index concurrently`).
- Startup retries the database connection while the `db` container is
  still coming up.

## Databases created before `schema_migrations` existed

On its first run the runner finds an empty `schema_migrations` table and
replays **every** migration once. This is safe: all migrations shipped
before the runner are idempotent (`create ... if not exists`,
`create or replace ...`). Migrations added after the runner don't need to
be idempotent — they run exactly once.

## Downgrading

There are no down-migrations. To roll back, restore a
[database backup](backup.md) taken before the upgrade and check out the
matching code revision.
