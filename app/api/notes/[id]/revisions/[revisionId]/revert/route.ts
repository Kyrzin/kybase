// POST /api/notes/[id]/revisions/[revisionId]/revert — put the note's title
// and content back the way this revision recorded them (lib/history.ts).
// Body: { expected_updated_at } — the updated_at the caller last read; a note
// changed since then is refused (409 conflict) rather than overwritten.
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { isInvalidTextRepresentation } from '@/lib/db';
import { isRevisionId, revertToRevision } from '@/lib/history';
import { requestActor } from '@/lib/route-auth';

const RevertSchema = z.object({
  expected_updated_at: z.string(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; revisionId: string }> }
) {
  const { id, revisionId } = await params;
  if (!isRevisionId(revisionId)) {
    return NextResponse.json({ error: 'Malformed revision id' }, { status: 400 });
  }
  const parsed = RevertSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const { expected_updated_at } = parsed.data;
  if (Number.isNaN(new Date(expected_updated_at).getTime())) {
    return NextResponse.json({ error: 'expected_updated_at is not a valid timestamp' }, { status: 400 });
  }

  let outcome;
  try {
    outcome = await revertToRevision(id, revisionId, expected_updated_at, await requestActor(req));
  } catch (err) {
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed note id' }, { status: 400 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Revert failed' }, { status: 500 });
  }

  switch (outcome.status) {
    case 'ok':
      return NextResponse.json({ note: outcome.note });
    case 'conflict':
      return NextResponse.json({ error: 'conflict', updated_at: outcome.updated_at }, { status: 409 });
    case 'title_taken':
      return NextResponse.json({ error: 'title_taken' }, { status: 409 });
    case 'no_content':
      // A delete/restore event: there is no text to go back to.
      return NextResponse.json({ error: 'no_content' }, { status: 400 });
    case 'not_found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
