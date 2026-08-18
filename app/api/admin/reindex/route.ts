import { NextRequest, NextResponse } from 'next/server';
import { startReindex, getReindexProgress, cancelReindex } from '@/lib/reindex';

// Starts a reindex in the background and returns immediately — the old
// synchronous version ran the whole batch inside this one request, so a
// long reindex outlived the browser/proxy timeout while the server kept
// burning quota with no way to check progress or stop it. The client polls
// GET below instead.
export async function POST(req: NextRequest) {
  const all = new URL(req.url).searchParams.get('mode') === 'all';
  const { started, progress } = startReindex(all ? 'all' : 'pending');
  if (!started) return NextResponse.json({ error: 'A reindex is already running', progress }, { status: 409 });
  return NextResponse.json(progress);
}

export async function GET() {
  return NextResponse.json(getReindexProgress() ?? { running: false, mode: 'pending', done: 0, total: 0, errors: [] });
}

export async function DELETE() {
  return NextResponse.json({ cancelled: cancelReindex(), progress: getReindexProgress() });
}
