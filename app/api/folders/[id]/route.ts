import { NextRequest, NextResponse } from 'next/server';
import { withTransaction, isUniqueViolation, FOLDER_REPARENT_LOCK_KEY } from '@/lib/db';
import { trashFolderNotes } from '@/lib/trash';
import { z } from 'zod';

/** Thrown inside the delete transaction so it rolls back, caught for a 404. */
class FolderNotFound extends Error {}
/** Thrown inside the update transaction so it rolls back, caught for a 400. */
class FolderCycle extends Error {}

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
  if (parsed.data.parent_id !== undefined && parsed.data.parent_id === id) {
    return NextResponse.json({ error: 'Folder cannot be its own parent' }, { status: 400 });
  }

  const sets: string[] = [];
  const sqlParams: unknown[] = [];
  const set = (col: string, val: unknown) => { sqlParams.push(val); sets.push(`${col} = $${sqlParams.length}`); };
  if (parsed.data.name      !== undefined) set('name', parsed.data.name);
  if (parsed.data.parent_id !== undefined) set('parent_id', parsed.data.parent_id);
  if (sets.length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }
  sqlParams.push(id);

  try {
    const data = await withTransaction(async (client) => {
      if (parsed.data.parent_id !== undefined && parsed.data.parent_id !== null) {
        // Only reparenting can create a cycle, so only it pays for the lock
        // — a plain rename proceeds without contention.
        await client.query('select pg_advisory_xact_lock($1)', [FOLDER_REPARENT_LOCK_KEY]);
        const { rows: cycleRows } = await client.query<{ id: string }>(
          `WITH RECURSIVE ancestors AS (
             SELECT id, parent_id FROM folders WHERE id = $1
             UNION
             SELECT f.id, f.parent_id FROM folders f
             INNER JOIN ancestors a ON f.id = a.parent_id
           )
           SELECT id FROM ancestors WHERE id = $2`,
          [parsed.data.parent_id, id]
        );
        if (cycleRows.length > 0) throw new FolderCycle();
      }
      const { rows } = await client.query(
        `update folders set ${sets.join(', ')} where id = $${sqlParams.length} returning *`,
        sqlParams
      );
      return rows[0] ?? null;
    });
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof FolderCycle) {
      return NextResponse.json({ error: 'Cannot move a folder into its own descendant' }, { status: 400 });
    }
    if (isUniqueViolation(err)) {
      return NextResponse.json({ error: 'A folder with this name already exists in this directory' }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : 'Update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let trashed: number;
  try {
    // One transaction: notes in the subtree must land in the trash together
    // with the folder disappearing, not one without the other. Child
    // folders still cascade via the FK once this commits.
    trashed = await withTransaction(async (client) => {
      const count = await trashFolderNotes(id, client);
      // `returning`: answering 204 for a folder that was never there hides
      // the mismatch from whoever is holding the stale id — the MCP tool for
      // this same operation already refuses it.
      const { rows } = await client.query('delete from folders where id = $1 returning id', [id]);
      if (rows.length === 0) throw new FolderNotFound();
      return count;
    });
  } catch (err) {
    if (err instanceof FolderNotFound) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
  // The count the UI needs to say what just happened — a folder delete now
  // reaches every note in the subtree, which a confirm dialog cannot show.
  return NextResponse.json({ trashed }, { status: 200 });
}
