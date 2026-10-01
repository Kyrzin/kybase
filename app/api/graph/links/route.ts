// GET /api/graph/links — wikilink edges between live notes, as ids; no node cap.
import { NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { dedupeEdges } from '@/lib/graph';
import { wikilinkEdges } from '@/lib/note-links';

export async function GET() {
  try {
    const notes = await query<{ id: string; title: string }>('select id, title from notes where deleted_at is null');
    const { edges } = await wikilinkEdges(notes);
    return NextResponse.json(dedupeEdges(edges));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
