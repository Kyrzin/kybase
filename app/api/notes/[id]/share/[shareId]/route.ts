// DELETE /api/notes/:id/share/:shareId — revoke a share link.
// shareId is note_shares.id (a uuid), not the secret token — the token
// itself never needs to appear in a URL/server log to revoke it.
// Master-secret-protected by proxy.ts.
import { NextRequest, NextResponse } from 'next/server';
import { revokeShare } from '@/lib/shares';
import { isInvalidTextRepresentation } from '@/lib/db';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; shareId: string }> }
) {
  const { id, shareId } = await params;
  try {
    const revoked = await revokeShare(id, shareId);
    if (!revoked) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    // shareId now compares against a uuid column (it used to be free-form
    // text, the token itself) — a malformed id (a stale bookmark, a client
    // still sending the old secret-token param) throws here instead of just
    // failing to match. Report it as the client error it is, not a 500.
    if (isInvalidTextRepresentation(err)) {
      return NextResponse.json({ error: 'Malformed share id' }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
