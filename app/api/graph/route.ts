import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { extractAllWikilinks } from '@/lib/wikilinks';
import { getSemanticEdges, type SemanticEdge } from '@/lib/semantic-edges';

export async function GET() {
  let notes: { id: string; title: string; content: string }[];
  try {
    notes = await query('select id, title, content from notes');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const nodes = notes.map((n) => ({ id: n.id, title: n.title }));

  // Build title→id lookup (case-insensitive)
  const titleToId = new Map<string, string>(
    notes.map((n) => [n.title.toLowerCase(), n.id])
  );

  const edges: { from: string; to: string }[] = [];
  for (const note of notes) {
    for (const target of extractAllWikilinks(note.content)) {
      const targetId = titleToId.get(target.toLowerCase());
      if (targetId && targetId !== note.id) {
        edges.push({ from: note.id, to: targetId });
      }
    }
  }

  // Second edge source: embedding cosine similarity (undirected, computed
  // in Postgres). Must not take down the wikilink graph if the query fails.
  let semantic_edges: SemanticEdge[] = [];
  try {
    semantic_edges = await getSemanticEdges(0.75, 5);
  } catch (err) {
    console.error('[graph] semantic edges:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ nodes, edges, semantic_edges });
}
