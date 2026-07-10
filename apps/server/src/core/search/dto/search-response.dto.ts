import { Space } from '@docmost/db/types/entity.types';

export class SearchResponseDto {
  id: string;
  title: string;
  icon: string;
  parentPageId: string;
  creatorId: string;
  rank: number;
  highlight: string;
  createdAt: Date;
  updatedAt: Date;
  space: Partial<Space>;
}

// Response shape for the opt-in agent-lookup mode (#443, `substring: true`).
// Additive to the FTS response: carries the location (`path`), a windowed
// `snippet` around the first match and a per-response sort `score`. The MCP
// layer maps `id → pageId`; `slugId` is never exposed.
export class SearchLookupResponseDto {
  id: string;
  slugId: string;
  title: string;
  parentPageId: string | null;
  // Ancestor titles from the space root down to the direct parent; [] for a
  // root page.
  path: string[];
  // ~300–500 chars around the first match (or a leading text window / extended
  // ts_headline fallback).
  snippet: string;
  // 0..1 float, meaningful ONLY for sorting within one response.
  score: number;
}
