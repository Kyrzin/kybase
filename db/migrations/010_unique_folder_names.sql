-- 010: one folder name per parent
--
-- folders had no uniqueness on (name, parent) — a race between concurrent
-- imports (ensureFolderPath in app/api/import/route.ts) or two clients could
-- create two sibling folders with the same name, splitting a subtree in two.
-- Case-insensitive to match how notes.title is unique (migration 006) and how
-- the app resolves folders by name.
--
-- parent_id is nullable (top-level folders), and NULLs are distinct in a plain
-- unique index — so two top-level "Projects" would slip through. coalesce to a
-- sentinel UUID makes NULL a normal comparable value, closing that gap.
--
-- Existing databases with duplicates must dedupe BEFORE this applies (the
-- index creation fails otherwise). Find them with:
--   select coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid) as parent,
--          lower(name), count(*)
--   from folders group by 1, 2 having count(*) > 1;
-- then merge each duplicate group's notes into one folder and delete the rest.

create unique index if not exists folders_name_parent_unique_ci
  on folders (lower(name), coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));
