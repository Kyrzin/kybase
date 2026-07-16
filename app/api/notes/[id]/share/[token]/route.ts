// DELETE /api/notes/:id/share/:token — revoke a share link.
// Master-secret-protected by middleware.
import { NextRequest, NextResponse } from 'next/server';
import { revokeShare } from '@/lib/shares';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; token: string }> }
) {
  const { id, token } = await params;
  try {
    const revoked = await revokeShare(id, token);
    if (!revoked) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
