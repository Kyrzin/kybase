// Search: text (FTS + substring) and semantic (chunk) retrieval, fusion, optional reranking.
export type { SearchResult, SearchFilters, NamedResultList, HybridSearchResult, ArmFailure } from './types';
export type { Fusion } from './config';
export { stripLeadingHeading, tableHeaderAbove, bestPassageOffset, makeExcerpt } from './excerpt';
export { questionEcho } from './signals';
export { textSearch } from './text';
export { effectiveSemanticThreshold, semanticSearch, bestSemanticScore } from './semantic';
export { rrfMerge } from './fusion';
export { SearchUnavailableError, hybridSearch } from './hybrid';
export { searchWithDiagnostics, universalSearch } from './service';
export type { SearchMode, SearchOptions, SearchDiagnostics } from './service';
export { searchInNote } from './in-note';
export type { InNoteSearch } from './in-note';
