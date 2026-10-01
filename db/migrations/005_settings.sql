-- 005: key-value settings store
--
-- Backs the settings UI (embedding provider switcher, API keys).
-- Values here override the corresponding env vars — see lib/settings.ts.

create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
