# Upgrading

```bash
git pull
docker compose up -d --build
```

That's the whole procedure. The rest of this page explains what happens
underneath.

## Ollama no longer starts by default

Up to v1.4, `docker compose up -d` started a bundled Ollama. It does not any
more: its image carries NVIDIA and AMD GPU runtimes whatever the host has, and
that is roughly 4 GB nobody using Google or OpenAI embeddings would ever run.

**If your vault uses local embeddings, add one line to `.env` before
upgrading:**

```
COMPOSE_PROFILES=ollama
```

Without it, an already-running Ollama is not stopped — it is left out. A
profile that is not selected is invisible to `up`, `down`, `pull` and
`restart` alike, so the container keeps serving embeddings while no longer
being managed: the next image bump passes it by, and nothing says so.

Starting it explicitly puts it back under compose, and restarts nothing else:

```
docker compose --profile ollama up -d
```

To remove an orphan instead, name the profile so compose can see it:

```
docker compose --profile ollama down
```

Settings shows a warning, with the command, whenever the configured provider
cannot be reached — so a vault that does end up without Ollama says so rather
than quietly falling back to its text half.

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
