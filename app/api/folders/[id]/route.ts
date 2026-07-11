import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { z } from 'zod';

const UpdateFolderSchema = z.object({
  name:      z.string().min(1).max(255).optional(),
  parent_id: z.string().uuid().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id }  = await params;
  const body    = await req.json().catch(() => ({}));
  const parsed  = UpdateFolderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }

  const sets: string[] = [];
  const sqlParams: unknown[] = [];
  const set = (col: string, val: unknown) => { sqlParams.push(val); sets.push(`${col} = $${sqlParams.length}`); };
  if (parsed.data.name      !== undefined) set('name', parsed.data.name);
  if (parsed.data.parent_id !== undefined) {
    if (parsed.data.parent_id === id) {
      return NextResponse.json({ error: 'Folder cannot be its own parent' }, { status: 400 });
    }
    if (parsed.data.parent_id !== null) {
      const checkCycle = await queryOne<{ id: string }>(
        `WITH RECURSIVE ancestors AS (
           SELECT id, parent_id FROM folders WHERE id = $1
           UNION
           SELECT f.id, f.parent_id FROM folders f
           INNER JOIN ancestors a ON f.id = a.parent_id
         )
         SELECT id FROM ancestors WHERE id = $2`,
        [parsed.data.parent_id, id]
      );
      if (checkCycle) {
        return NextResponse.json({ error: 'Cannot move a folder into its own descendant' }, { status: 400 });
      }
    }
    set('parent_id', parsed.data.parent_id);
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  sqlParams.push(id);
  try {
    const data = await queryOne(
      `update folders set ${sets.join(', ')} where id = $${sqlParams.length} returning *`,
      sqlParams
    );
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await query('delete from folders where id = $1', [id]);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
