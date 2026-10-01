-- 003: fix update_wikilinks regex escaping
--
-- The escape class in 001 omitted '.', which is a regex metacharacter
-- (matches any character). Renaming a note whose title contains a dot
-- (e.g. "v1.2 notes") could therefore also rewrite wikilinks pointing at
-- an unrelated title differing only in that position (e.g. "v1X2 notes").

create or replace function update_wikilinks(old_title text, new_title text)
returns void language plpgsql as $$
declare
  -- Escape regex special chars in the title (including '.')
  escaped text := regexp_replace(old_title, '([.*+?^${}()|\[\]\\])', '\\\1', 'g');
begin
  update notes
  set content = regexp_replace(
    content,
    '\[\[' || escaped || '(\|[^\]]+)?\]\]',
    '[[' || new_title || '\1]]',
    'gi'
  )
  where content ~* ('\[\[' || escaped || '(\|[^\]]+)?\]\]');
end;
$$;
