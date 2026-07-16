-- 006: rename-safe section links + unique note titles
--
-- 1) update_wikilinks matched [[Title]] and [[Title|Alias]] but not
--    [[Title#Section]] / [[Title#Section|Alias]], although the app parses
--    those (lib/wikilinks.ts extractWikilinkTarget). Renaming a note
--    silently orphaned its section-anchored backlinks. The optional tail
--    now starts at '#' or '|' and is carried over verbatim.
--    Backslashes in the new title are doubled because regexp_replace
--    treats '\' specially in the replacement string.
--
-- 2) Titles are the de-facto primary key of the linking system (wikilinks
--    resolve case-insensitively by title), yet nothing prevented
--    duplicates, which make link resolution nondeterministic.
--    Existing databases must dedupe BEFORE applying:
--      select lower(title), count(*) from notes group by 1 having count(*) > 1;

create or replace function update_wikilinks(old_title text, new_title text)
returns void language plpgsql as $$
declare
  -- Escape regex special chars in the title (including '.')
  escaped  text := regexp_replace(old_title, '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
  safe_new text := replace(new_title, '\', '\\');
begin
  update notes
  set content = regexp_replace(
    content,
    '\[\[' || escaped || '([#|][^\]]*)?\]\]',
    '[[' || safe_new || '\1]]',
    'gi'
  )
  where content ~* ('\[\[' || escaped || '([#|][^\]]*)?\]\]');
end;
$$;

create unique index if not exists notes_title_unique_ci on notes (lower(title));
