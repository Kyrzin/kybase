import { NextRequest, NextResponse } from 'next/server';
import { listEmbeddingModels } from '@/lib/provider-models';
import type { EmbeddingProvider } from '@/lib/settings';

const PROVIDERS = new Set(['ollama', 'google', 'openai']);

/**
 * Embedding models the configured provider actually offers, for the settings
 * dialog's model picker.
 *
 * Its own route rather than a field on GET /api/settings: this one leaves the
 * server to talk to a third party over the network, and the settings dialog
 * must still open when that provider is unreachable or its key is wrong.
 * Failure comes back as an empty list plus a reason, never as a non-200 —
 * listEmbeddingModels does not throw.
 *
 * `provider` selects which one to ask, so the dialog can list models for a
 * provider the user is considering but has not saved yet.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('provider') ?? undefined;
  const provider = raw && PROVIDERS.has(raw) ? (raw as EmbeddingProvider) : undefined;
  return NextResponse.json(await listEmbeddingModels(provider));
}
