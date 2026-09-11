// lib/note-links.ts — the stored [[wikilink]] index (migration 031).
//
// Backlinks and the graph used to answer "who links here" by loading note
// content and running the parser over it on every call. This keeps the parse
// result instead, and recomputes only what has actually changed.
//
// One parser, still. Links are extracted by lib/wikilinks.ts here exactly as
// they were extracted inline before — no SQL trigger doing its own bracket
// matching. A trigger cannot follow code fences (see maskCode), so it would
// disagree with the renderer and with rename rewriting about which brackets
// are links, and a third opinion on that question is how the existing two
// came to differ in the first place.
import { query, withTransaction, LINK_INDEX_LOCK_KEY } from './db';
import { wikilinkOccurrences } from './wikilinks';

/** Characters of surrounding text kept on each side of a link. */
const CONTEXT_RADIUS = 120;

export type LinkRow = {
  source_note_id: string;
  raw: string;
  target_title: string;
  context: string | null;
  /** Null when the link resolves to no live note — a dangling link. */
  target_note_id: string | null;
};

/**
 * The sentence-ish window around a link, snapped to whitespace so a quote
 * does not start mid-word. Ellipses mark a cut, matching how excerpts read
 * elsewhere.
 */
function contextAround(content: string, index: number, length: number): string {
  let from = Math.max(0, index - CONTEXT_RADIUS);
  let to = Math.min(content.length, index + length + CONTEXT_RADIUS);
  if (from > 0) {
    const space = content.indexOf(' ', from);
    if (space !== -1 && space < index) from = space + 1;
  }
  if (to < content.length) {
    const space = content.lastIndexOf(' ', to);
    if (space !== -1 && space > index + length) to = space;
  }
  return (from > 0 ? '…' : '') + content.slice(from, to).trim() + (to < content.length ? '…' : '');
}

/**
 * Bring the link index up to date, parsing only the notes whose content has
 * moved since they were last parsed.
 *
 * Correctness rests on content_revision (migration 028), not on catching
 * every write path: whoever changes a note's title or content bumps it, and
 * anything that fails to update the index here is simply re-read next time.
 * The failure mode is a wasted parse, never a wrong graph.
 *
 * A note with no links still gets its stamp, so "never parsed" and "parsed,
 * found nothing" stay distinguishable — otherwise every link-free note would
 * be re-parsed forever.
 */
const STALE_NOTES_SQL =
  `select id, content, content_revision from notes
   where deleted_at is null and links_revision is distinct from content_revision`;

export async function refreshLinkIndex(): Promise<number> {
  // Cheap guard so a current index costs one read and no transaction. It is
  // only a guard: the set it returns is not the set that gets parsed.
  const maybeStale = await query(STALE_NOTES_SQL);
  if (maybeStale.length === 0) return 0;

  let parsed = 0;
  await withTransaction(async (client) => {
    // Serialised: the delete-then-insert below is not safe to run twice over
    // one note at once, and an agent issuing parallel tool calls is the
    // ordinary case, not a rare one. See LINK_INDEX_LOCK_KEY.
    await client.query('select pg_advisory_xact_lock($1)', [LINK_INDEX_LOCK_KEY]);
    // Re-read under the lock. Whoever waited here may have been waiting for
    // exactly this work, and redoing it would mean deleting rows the first
    // caller had just written.
    const { rows: stale } = await client.query<{ id: string; content: string; content_revision: string }>(STALE_NOTES_SQL, []);
    parsed = stale.length;
    for (const note of stale) {
      await client.query('delete from note_links where source_note_id = $1', [note.id]);
      const links = wikilinkOccurrences(note.content);
      for (const [i, link] of links.entries()) {
        // A same-note anchor — [[#Section]] — has no title before the '#'.
        // It is a real link for the reader but points at no note, so it is
        // not an edge and would only show up as permanently unresolved.
        const target = link.raw.split(/[#|]/)[0].trim();
        if (!target) continue;
        await client.query(
          `insert into note_links (source_note_id, occurrence, raw, target_title, context)
           values ($1, $2, $3, $4, $5)`,
          [note.id, i, link.raw, target, contextAround(note.content, link.index, link.raw.length + 4)]
        );
      }
      // Stamped with the revision the parse actually saw. A write landing
      // mid-refresh bumps content_revision again, so the note stays stale and
      // is re-parsed rather than being marked current on stale text.
      await client.query(
        'update notes set links_revision = $2 where id = $1 and content_revision = $2',
        [note.id, note.content_revision]
      );
    }
  });
  return parsed;
}

// Resolution mirrors extractWikilinkTarget: the whole raw string wins over
// the split, so a note genuinely titled "closed CodeQL #3" is found before
// the '#' is read as an anchor. Deleted notes resolve to nothing, which is
// the same answer the old in-memory pass gave — it only ever knew live ones.
//
// The source note is filtered the same way, and for the same reason. Rows
// survive a soft delete on purpose — restoring a note brings its links back
// without a reparse, since links_revision still matches — so a trashed note
// still HAS links here; they just are not links any more until it comes back.
const RESOLVED = `
  select l.source_note_id, l.raw, l.target_title, l.context,
         coalesce(whole.id, split.id) as target_note_id
  from note_links l
  join notes src on src.id = l.source_note_id and src.deleted_at is null
  left join notes whole on lower(whole.title) = lower(l.raw)          and whole.deleted_at is null
  left join notes split on lower(split.title) = lower(l.target_title) and split.deleted_at is null
`;

/**
 * Graph edges over a given set of notes, replacing the in-memory pass that
 * used to re-parse their content (buildWikilinkEdges).
 *
 * Resolution happens here rather than in SQL because the caller's note set is
 * the whole universe for it: with a folder filter, a link pointing outside
 * that folder is UNRESOLVED, not an edge to somewhere unseen. Answering that
 * from the database would resolve against every title in the vault and
 * quietly turn a scoped graph into a leaky one.
 *
 * Occurrence-level, self-links dropped, repeats kept — the caller dedupes.
 */
export async function wikilinkEdges(
  notes: { id: string; title: string }[]
): Promise<{ edges: { from: string; to: string }[]; unresolved: { from: string; target: string }[] }> {
  await refreshLinkIndex();
  const titleToId = new Map(notes.map((n) => [n.title.toLowerCase(), n.id]));
  const ids = notes.map((n) => n.id);
  const rows = ids.length === 0 ? [] : await query<{ source_note_id: string; raw: string; target_title: string }>(
    `select source_note_id, raw, target_title from note_links
     where source_note_id = any($1::uuid[]) order by source_note_id, occurrence`,
    [ids]
  );

  const edges: { from: string; to: string }[] = [];
  const unresolved: { from: string; target: string }[] = [];
  for (const row of rows) {
    // Whole raw string first, then the split — extractWikilinkTarget's rule,
    // so a title that itself contains '#' or '|' beats reading it as an anchor.
    const whole = titleToId.get(row.raw.trim().toLowerCase());
    const targetId = whole ?? titleToId.get(row.target_title.toLowerCase());
    if (!targetId) { unresolved.push({ from: row.source_note_id, target: row.target_title }); continue; }
    if (targetId !== row.source_note_id) edges.push({ from: row.source_note_id, to: targetId });
  }
  return { edges, unresolved };
}

export type Neighbor = {
  id: string;
  title: string;
  depth: number;
  /** The root links to this note. */
  links_out: boolean;
  /** This note links to the root. */
  links_in: boolean;
};

/**
 * The notes around one note, out to `depth` hops.
 *
 * Exists because the only way to see structure used to be get_graph, which
 * returns the entire vault — on the live one, ~9000 tokens of nodes and edges
 * to answer a question about a single note's surroundings. This answers that
 * question with the surroundings.
 *
 * Traversal is UNDIRECTED: a note that links here is a neighbour just as much
 * as one linked from here, and an agent asking "what is around this" wants
 * both (buildGraph's own neighbourhood BFS made the same call). Direction is
 * still reported, but only as the DIRECT relation to the root — at two hops
 * "which way does the arrow point" has no single answer, so both flags are
 * simply false there rather than describing some intermediate edge.
 *
 * Each note appears once, at the shortest depth that reaches it. Cycles are
 * cut by carrying the path, so a mutual link pair cannot recurse forever.
 */
export async function neighborsOf(noteId: string, depth: number): Promise<Neighbor[]> {
  await refreshLinkIndex();
  return query<Neighbor>(
    `with recursive edges as (
       -- Both endpoints must be live. Filtering only the target would leave a
       -- trashed note as a usable bridge: invisible in the output, yet still
       -- carrying the walk to whatever it linked to two hops out.
       select l.source_note_id as src, coalesce(whole.id, split.id) as dst
       from note_links l
       join notes s on s.id = l.source_note_id and s.deleted_at is null
       left join notes whole on lower(whole.title) = lower(l.raw)          and whole.deleted_at is null
       left join notes split on lower(split.title) = lower(l.target_title) and split.deleted_at is null
     ),
     linked as (
       -- Both directions, deduped: repeated links between the same pair are
       -- one connection here, however many times they were written.
       select distinct src as a, dst as b from edges where dst is not null and src <> dst
       union
       select distinct dst as a, src as b from edges where dst is not null and src <> dst
     ),
     walk as (
       select l.b as id, 1 as depth, array[l.a, l.b] as path
       from linked l where l.a = $1
       union all
       select l.b, w.depth + 1, w.path || l.b
       from linked l join walk w on l.a = w.id
       where w.depth < $2 and not (l.b = any(w.path))
     )
     select w.id, n.title, min(w.depth)::int as depth,
            bool_or(exists (select 1 from edges e where e.src = $1 and e.dst = w.id)) as links_out,
            bool_or(exists (select 1 from edges e where e.src = w.id and e.dst = $1)) as links_in
     from walk w
     join notes n on n.id = w.id and n.deleted_at is null
     where w.id <> $1
     group by w.id, n.title
     order by min(w.depth), n.title`,
    [noteId, depth]
  );
}

/**
 * Notes linking to `noteId`, one row per occurrence, with the text around
 * each link. Ordered by note so pagination is stable.
 */
export async function backlinksTo(noteId: string): Promise<LinkRow[]> {
  await refreshLinkIndex();
  return query<LinkRow>(
    `select * from (${RESOLVED}) r
     where r.target_note_id = $1 and r.source_note_id <> $1
     order by r.source_note_id`,
    [noteId]
  );
}
