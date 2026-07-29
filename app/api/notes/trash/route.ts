// GET /api/notes/trash — list soft-deleted notes (see lib/trash.ts).
// A static segment, resolved before the [id] dynamic route for this literal path.
import { NextResponse } from 'next/server';
import { listTrash } from '@/lib/trash';

export async function GET() {
  return NextResponse.json(await listTrash());
}
