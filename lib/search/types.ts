export type SearchResult = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
  // 0..1 relative to the best hit of this response; orders hits, says nothing
  // about quality and is not comparable across queries. On hybrid results it
  // is the max of the contributing arms.
  relevance: number;
  // Hybrid only, per arm that matched: FTS ts_rank (or the substring fallback
  // score) and raw cosine similarity. Debugging aids, not an ordering.
  text_score?: number;
  semantic_score?: number;
  matched_by?: ('text_score' | 'semantic_score')[];
  // Text-arm cascade level: 'and' = the strict query matched; 'or' and
  // 'substring' = a looser pass filled in.
  text_tier?: 'and' | 'or' | 'substring';
  // The identifier-shaped query occurs verbatim in the note (see textSearch).
  exact?: boolean;
  // Heading the excerpt sits under; get_note's `section` accepts it.
  section?: string;
  // IDF-weighted fraction of the query's significant words present in the note.
  coverage?: number;
  created_at?: string;
  content_length?: number;
  // Character offset of the excerpt, in get_note `offset` units. Long notes
  // only, and only when the excerpt was located exactly.
  excerpt_offset?: number;
  // The note lists the query as a question without answering it.
  question_echo?: boolean;
  // The note's vectors are being rebuilt; the excerpt may predate its text.
  index_pending?: boolean;
  // Cross-encoder score of the best passage, present only when reranking ran.
  rerank_score?: number;
};

export type SearchFilters = {
  folderId?: string;
  tag?: string;
  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;
};

export type NamedResultList = { field: 'text_score' | 'semantic_score'; results: SearchResult[] };

// Merged results carry rrf_score instead of `score`: a rank-fusion diagnostic,
// not comparable to a single arm's score.
export type HybridSearchResult = Omit<SearchResult, 'score'> & { rrf_score: number };

export type ArmFailure = { arm: 'text' | 'semantic'; reason: string };
