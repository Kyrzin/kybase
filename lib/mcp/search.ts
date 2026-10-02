import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { queryOne } from '../db';
import { searchWithDiagnostics, searchInNote, SearchUnavailableError, type SearchResult, type HybridSearchResult, type SearchDiagnostics } from '../search';
import { getSemanticProfile } from '../embeddings';
import { folderIdFromPath } from '../folders';
import { uuid, QUERY_REQUIRED, morePage } from './shared';

export function registerSearchTools(server: McpServer): void {
  // Display rounding only: ratios get 2 decimals, raw scores (ts_rank, cosine,
  // RRF) get 3, since they are compared against each other.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const round3 = (n: number) => Math.round(n * 1000) / 1000;

  // Display shape: raw arm scores and created_at only under explain, numbers
  // rounded, JSON pretty-printed for clients that show the raw string.
  function toDisplayResult(r: SearchResult | HybridSearchResult, explain: boolean): Record<string, unknown> {
    const hybrid = r as Partial<HybridSearchResult>;
    const out: Record<string, unknown> = {
      id: r.id,
      title: r.title,
      excerpt: r.excerpt,
      tags: r.tags,
      relevance: round2(r.relevance),
    };
    if (hybrid.matched_by) out.matched_by = hybrid.matched_by;
    // Observed facts about the text match: which cascade level found it and
    // how much of the query it contains. Shipped when they say something a
    // reader would not assume — a non-'and' tier or coverage below 1 — and
    // always under explain.
    if (r.text_tier && (explain || r.text_tier !== 'and')) out.text_tier = r.text_tier;
    if (r.coverage !== undefined && (explain || r.coverage < 1)) out.coverage = round2(r.coverage);
    // Only ever shipped as true: `exact: false` on nearly every hit would be
    // noise, and its absence already means "not verbatim".
    if (r.exact) out.exact = true;
    // Same "only ever true" rule: this note lists your question without
    // answering it, so its match is about the string, not the content.
    if (r.question_echo) out.question_echo = true;
    // The note's own text is current; only its vectors are still rebuilding,
    // so this excerpt may be from the previous version. get_note returns the
    // live text.
    //
    // The hint travels with the field instead of riding in every tool description.
    if (r.index_pending) {
      out.index_pending = true;
      out.hint = 'Excerpt is from a previous version of this note; read it with get_note before quoting.';
    }
    if (r.section) out.section = r.section;
    if (r.content_length !== undefined) out.content_length = r.content_length;
    // Where the excerpt sits, for a note long enough that reading it whole is
    // not an option. Absent on short notes and whenever the position could not
    // be established exactly.
    if (r.excerpt_offset !== undefined) out.excerpt_offset = r.excerpt_offset;
    // Shipped without explain, unlike the raw arm scores: when a cross-encoder
    // reordered the page, this is the number that decided the order the
    // caller is reading, and the order is not explainable from the other
    // fields. Absent whenever reranking did not run.
    if (r.rerank_score !== undefined) out.rerank_score = round3(r.rerank_score);
    if (explain) {
      // Hybrid results carry text_score/semantic_score per arm. A plain result's
      // `score` is its one arm's raw number, surfaced under the same field name;
      // text_tier (set only by the text arm) tells which.
      const plain = r as Partial<SearchResult>;
      if (hybrid.text_score !== undefined) out.text_score = round3(hybrid.text_score);
      else if (plain.score !== undefined && plain.text_tier !== undefined) out.text_score = round3(plain.score);
      if (hybrid.semantic_score !== undefined) out.semantic_score = round3(hybrid.semantic_score);
      else if (plain.score !== undefined && plain.text_tier === undefined) out.semantic_score = round3(plain.score);
      if (hybrid.rrf_score !== undefined) out.rrf_score = round3(hybrid.rrf_score);

      if (r.created_at) out.created_at = r.created_at;
    }
    return out;
  }

  // ── search_notes ─────────────────────────────────────────────────────────
  server.tool(
    'search_notes',
    // Kept deliberately short. Everything here is a rule the caller can act on
    // with a field name to act through; what a field MEANS travels with the
    // field (toDisplayResult's hints), and what applies to more than this tool
    // lives in the server instructions. Algorithm internals — rank fusion, the
    // cross-encoder, how coverage is derived — are not here at all: they change
    // no decision a caller makes, and this text is re-sent on every request.
    'Search notes: hybrid (keyword + meaning) by default. Returns ranked excerpts, not whole notes.\n\n' +
    '- Use type="text" for an exact identifier, filename, code symbol or quoted phrase; "hybrid" ' +
    'for questions and topics.\n' +
    '- READ THE SECTION, NOT THE NOTE. A hit\'s `section` is the heading its excerpt came from — ' +
    'pass that string to get_note\'s `section` to get that part alone. If a long hit has no ' +
    '`section`, get_note with limit:1000 returns its `headings` outline; pick one and re-read with ' +
    '`section`. For prose without headings, a hit\'s `excerpt_offset` goes to get_note as `offset`.\n' +
    '- A hit is a candidate, not an answer. `relevance` is relative to the best hit in this ' +
    'response, so the top result always reads 1.0 — an ordering, not a verdict; `best_score` is ' +
    'that hit\'s own raw similarity. `matched_by` says which arms found it: semantic_score ' +
    'alone means "about something similar", never that it confirms your question. Quote the excerpt ' +
    'or open the note — a score is never evidence. `exact:true` means the query occurs verbatim in ' +
    'that note; `text_tier` of "or" or "substring" means the strict words missed and a looser pass ' +
    'filled in — recall, not confirmation.\n' +
    '- A long note such as a book comes back as one hit with one excerpt. To find more places in it, ' +
    'search again with its `note_id`: results are then places inside that note, best first.\n' +
    '- Dates here filter, they do not rank. For "what changed lately" use list_notes, which sorts ' +
    'by recency; it is also how you browse by folder or tag, since a query is required here.\n' +
    '- `has_more` with `next_offset` pages the results.',
    {
      // The message matters more than the rule: an agent that wanted "every
      // note tagged X" hits this and needs to be told where that lives, not
      // that a string was expected.
      query:          z.string({ error: QUERY_REQUIRED }).min(1, QUERY_REQUIRED)
        .describe('What to look for: words or a question for hybrid/semantic, an exact identifier, path or phrase for type "text"'),
      type:           z.enum(['text', 'semantic', 'hybrid']).default('hybrid')
        .describe('"hybrid" fuses keyword and meaning-based matching and is the right default; "text" is keyword-only and exact; "semantic" is meaning-only'),
      limit:          z.number().int().min(1).max(50).default(5)
        .describe('Hits per page. Prefer has_more with offset over asking for one large page'),
      offset:         z.number().int().min(0).default(0)
        .describe('Skip this many hits — with has_more in the response, how you read past the first page'),
      folder_id:      uuid().optional().describe('Restrict to notes in this folder itself, not its subfolders'),
      folder_path:    z.string().optional()
        .describe('Same restriction by path (e.g. "Projects/Kybase") instead of UUID — that folder itself, not its subfolders'),
      tag:            z.string().optional().describe('Restrict to notes with this tag'),
      created_after:  z.string().optional().describe('ISO timestamp — only notes created at or after this'),
      created_before: z.string().optional().describe('ISO timestamp — only notes created at or before this'),
      updated_after:  z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or after this'),
      updated_before: z.string().optional().describe('ISO timestamp — only notes whose own content actually changed at or before this'),
      rerank:         z.boolean().default(true)
        .describe('Set false to skip the cross-encoder and answer from the fused order — several times faster, and not measurably worse. Applies to type "hybrid" only: text and semantic never rerank, and this flag changes nothing there'),
      explain:        z.boolean().default(false).describe('Include raw per-arm scores and created_at for debugging ranking'),
      note_id:        uuid().optional()
        .describe('Search inside this one note: results are places in it, best first, instead of one hit per note. Not combinable with folder, tag or date filters'),
    },
    async ({ query: q, type, limit, offset, folder_id, folder_path, tag, created_after, created_before, updated_after, updated_before, rerank, explain, note_id }) => {
      if (folder_id && folder_path) throw new Error('Provide either folder_id or folder_path, not both');
      if (note_id && (folder_id || folder_path || tag || created_after || created_before || updated_after || updated_before)) {
        throw new Error('note_id already names the one note to search — drop the folder, tag and date filters');
      }
      const filters = {
        folderId: folder_path ? await folderIdFromPath(folder_path) : folder_id,
        tag,
        createdAfter: created_after, createdBefore: created_before,
        updatedAfter: updated_after, updatedBefore: updated_before,
      };
      // One run through the shared entry point, with diagnostics from the same execution.
      let results: SearchResult[];
      let diagnostics: SearchDiagnostics;
      try {
        if (note_id) {
          const run = await searchInNote(note_id, q, { mode: type, limit, offset, explain, rerank });
          if (!run) throw new Error('Note not found');
          return { content: [{ type: 'text' as const, text: JSON.stringify({
            results: run.results.map((r) => toDisplayResult(r, explain)),
            ...morePage(run.hasMore, limit, offset),
            embedding_model: run.embeddingModel,
            arms_used: run.armsUsed,
            ...(run.failures.length > 0 ? { arms_unavailable: run.failures } : {}),
            // Empty or thin results can mean the note is still being indexed,
            // not that the words are absent from it.
            ...(run.indexPending ? { index_pending: true } : {}),
            ...(run.rerankEnabled ? { reranked: run.reranked } : {}),
          }, null, 2) }] };
        }
        ({ results, diagnostics } = await searchWithDiagnostics(q, { mode: type, limit, offset, filters, rerank, explain }));
      } catch (err) {
        // Every arm is down. An empty result list here would be a claim about
        // the vault; this is a claim about the service.
        if (err instanceof SearchUnavailableError) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'search_unavailable',
              message: 'No search backend is currently answering — this is a service failure, not an empty vault.',
              arms_unavailable: err.failures,
            }, null, 2) }],
          };
        }
        throw err;
      }

      const displayResults = results.map((r) => toDisplayResult(r, explain));

      if (type === 'text') {
        // Always {results: [...]}, the same top-level shape as the other modes.
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          results: displayResults,
          ...morePage(diagnostics.has_more, limit, offset),
        }, null, 2) }] };
      }

      // best_score returned unconditionally, not just on an empty result —
      // relevance is only ever relative to the best hit IN THIS RESPONSE
      // (semanticSearch/rrfMerge), so an agent has no way to tell "a
      // confident 0.85 cosine" from "the least-bad of a weak field" without
      // this number to compare against.
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results: displayResults,
            ...morePage(diagnostics.has_more, limit, offset),
            // null = no cutoff configured; 0 would read like a real bound.
            threshold: diagnostics.semantic_threshold === null ? null : round2(diagnostics.semantic_threshold),
            best_score: diagnostics.best_semantic_score === null ? null : round3(diagnostics.best_semantic_score),
            pending_embeddings: diagnostics.index.pending,
            // Chunks still holding vectors from a previous embedding model.
            // They are excluded from semantic results (migration 028) rather
            // than compared against a query from a different geometry, so a
            // non-zero value here explains a thin semantic arm without the
            // agent having to guess.
            stale_generation_chunks: diagnostics.index.stale_generation,
            embedding_model: diagnostics.embedding_model,
            // Which arms actually answered. A semantic/hybrid response built
            // from the text arm alone is a degraded result, not a verdict
            // about the vault.
            arms_used: diagnostics.arms_used,
            ...(diagnostics.arms_unavailable.length > 0
              ? { arms_unavailable: diagnostics.arms_unavailable }
              : {}),
            // Whether a cross-encoder decided this order instead of rank
            // fusion. Absent on a vault with no reranker installed, so those
            // responses stay the size they were. Present and false only when
            // one is switched on and did not answer — a fault worth seeing,
            // because the results are then the un-reranked ones.
            ...(diagnostics.rerank.enabled ? { reranked: diagnostics.reranked } : {}),
          }, null, 2),
        }],
      };
    }
  );

  // ── indexing_status ──────────────────────────────────────────────────────
  server.tool(
    'indexing_status',
    // search_notes already reports pending_embeddings and
    // stale_generation_chunks on every semantic response, so this is the
    // deliberate second look, not the only way to learn the index is behind.
    'Semantic index progress: total/indexed/pending, complete=true when pending is 0. Pending notes ' +
    'are still found by text search; ones never embedded stay out of semantic results until the ' +
    'background pass reaches them.\n\n' +
    'Also names the active embedding model and the configured similarity cutoff ' +
    '(`semantic_min_similarity`, null when there is none — the default, meaning nothing is refused ' +
    'for being too dissimilar). Cosines are not comparable between models, which is why the model ' +
    'is named rather than left to be guessed from a score.',
    {},
    async () => {
      const row = await queryOne<{ total: number; pending: number }>(
        `select count(*)::int as total,
                (count(*) filter (where embedding_pending))::int as pending
         from notes where deleted_at is null`
      );
      const total = row?.total ?? 0;
      const pending = row?.pending ?? 0;
      const profile = await getSemanticProfile();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total, indexed: total - pending, pending, complete: pending === 0,
            embedding_model: profile.model,
            semantic_min_similarity: profile.minSimilarity,
            semantic_profile: profile.status,
          }),
        }],
      };
    }
  );
}
