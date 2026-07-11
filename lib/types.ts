// lib/types.ts — shared data types (importable from both client and server)

export type Folder = {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
};

// Shape returned by /api/search — short excerpt instead of full content
export type SearchHit = {
  id: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
};

export type Note = {
  id: string;
  title: string;
  content: string;
  folder_id: string | null;
  tags: string[];
  embedding_pending: boolean;
  created_at: string;
  updated_at: string;
};
