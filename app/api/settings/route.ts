import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { setSetting, getEmbeddingConfig, getFtsLanguages, setFtsLanguages, getTagWeights, setTagWeights, getFolderWeights, setFolderWeights, getEmbeddingBands, setEmbeddingBands } from '@/lib/settings';
import { z } from 'zod';

const UpdateSettingsSchema = z.object({
  provider:     z.enum(['ollama', 'google', 'openai']).optional(),
  googleApiKey: z.string().min(1).optional(),
  openaiApiKey: z.string().min(1).optional(),
  ollamaModel:  z.string().min(1).optional(),
  // migration 016 — notes_search_vector_trigger/search_notes_fts combine
  // these (plus 'simple', always) instead of the old hardcoded ru+en pair.
  // No per-language validation here — an unregistered Postgres text search
  // config name is caught and skipped inside the trigger itself, not here.
  ftsLanguages: z.array(z.string().min(1)).min(1).optional(),
  // Mechanic (lib/search.ts multiplies a hit's raw rank by this before
  // normalizing) is in code; the tags and their weights are entirely this
  // vault's own vocabulary — empty object clears it back to a no-op.
  // getTagWeights() re-validates on read too (positive finite only), so a
  // bad value here degrades to "that one entry ignored", not a broken search.
  tagWeights: z.record(z.string(), z.number()).optional(),
  // Same mechanic, keyed by folder_id (uuid) instead of tag name — migration
  // 021 adds folder_id to search_notes_fts for exactly this multiply.
  // getFolderWeights() re-validates on read too; a folder_id that doesn't
  // exist (typo, later-deleted folder) just never matches anything, same as
  // an unknown tag name.
  folderWeights: z.record(z.string(), z.number()).optional(),
  // Optional minimum cosine per model key, and the ONLY way one ever applies:
  // kybase ships no semantic cutoff of its own any more (lib/embeddings.ts
  // records what was measured and why it was withdrawn). Absent by default,
  // which means no automatic abstention at all. Someone with a homogeneous
  // corpus who has measured their own model can set one here without a code
  // change or a redeploy — precision tuning, not a correctness feature.
  embeddingBands: z.record(z.string(), z.object({
    gate:        z.number().min(0).max(0.999).optional(),
    signalFloor: z.number().min(0.001).max(0.999).optional(),
  })).optional(),
});

// Auth is proxy.ts.ts (session cookie or master-secret bearer) — this
// route used to re-check the bearer itself too, which only re-verified the
// same secret through a second code path and went stale the moment the UI
// stopped sending it (see the session-cookie change): the browser started
// getting 401s here even though proxy.ts had already let it through.
export async function GET() {
  const [cfg, ftsLanguages, tagWeights, folderWeights, embeddingBands] = await Promise.all([
    getEmbeddingConfig(), getFtsLanguages(), getTagWeights(), getFolderWeights(), getEmbeddingBands(),
  ]);
  return NextResponse.json({
    provider: cfg.provider,
    ollamaModel: cfg.ollamaModel,
    hasGoogleKey: !!cfg.googleApiKey,
    hasOpenaiKey: !!cfg.openaiApiKey,
    ftsLanguages,
    tagWeights,
    folderWeights,
    embeddingBands,
  });
}

export async function PUT(req: NextRequest) {
  const raw    = await req.json().catch(() => ({}));
  const parsed = UpdateSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.format() }, { status: 400 });
  }
  const body = parsed.data;

  const currentCfg = await getEmbeddingConfig();
  const providerChanged = body.provider && body.provider !== currentCfg.provider;

  if (body.provider)     await setSetting('embedding_provider', body.provider);
  if (body.googleApiKey) await setSetting('google_api_key',     body.googleApiKey);
  if (body.openaiApiKey) await setSetting('openai_api_key',     body.openaiApiKey);
  if (body.ollamaModel)  await setSetting('ollama_model',       body.ollamaModel);
  if (body.ftsLanguages)  await setFtsLanguages(body.ftsLanguages);
  if (body.tagWeights)    await setTagWeights(body.tagWeights);
  if (body.folderWeights) await setFolderWeights(body.folderWeights);
  // Merge, not replace: a vault that has measured two models keeps both.
  if (body.embeddingBands) await setEmbeddingBands({ ...(await getEmbeddingBands()), ...body.embeddingBands });

  // Mark all live notes for reindex when provider changes. Used to also
  // kick off /api/admin/reindex itself right here — a single Save click
  // silently re-embedding the whole vault against a fresh API key/quota
  // with no confirmation. Now it only flags the notes; the caller decides
  // whether to run "Reindex" right away.
  let pendingCount = 0;
  if (providerChanged) {
    const marked = await query<{ id: string }>('update notes set embedding_pending = true where deleted_at is null returning id');
    pendingCount = marked.length;
  }
  // A language list change needs every note's search_vector recomputed —
  // same forced-recompute trick migration 016's own backfill uses.
  if (body.ftsLanguages) {
    await query('update notes set title = title where deleted_at is null');
  }

  return NextResponse.json({ ok: true, reindexTriggered: providerChanged, pendingCount });
}
