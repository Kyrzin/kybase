# Backups

Everything lives in one Postgres volume, so a complete backup is one
`pg_dump`. The markdown **Export .zip** (Settings → Export) is a good second
layer — plain files, readable without Kybase — but `pg_dump` is the complete
one: it also preserves note ids, folder ids, and embeddings.

## Nightly dump

```bash
docker compose exec -T db pg_dump -U kybase kybase | gzip \
  > kybase-$(date +%F).sql.gz
```

Cron example (03:00 daily, keep two weeks):

```cron
0 3 * * * cd /path/to/kybase && docker compose exec -T db pg_dump -U kybase kybase | gzip > backups/kybase-$(date +\%F).sql.gz && find backups -name 'kybase-*.sql.gz' -mtime +14 -delete
```

## Restore

Into a fresh instance (empty database volume):

```bash
docker compose up -d db
gunzip -c kybase-2026-07-16.sql.gz | docker compose exec -T db psql -U kybase kybase
docker compose up -d
```

The dump includes the `schema_migrations` table, so the app recognizes the
restored schema on startup and applies only migrations newer than the dump.
