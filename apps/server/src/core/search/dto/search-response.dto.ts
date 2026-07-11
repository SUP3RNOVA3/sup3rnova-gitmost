import { Space } from '@docmost/db/types/entity.types';

// #529 A7 — the single per-hit SUPERSET returned by the unified search engine.
// The web-UI reads id/highlight/icon/space/title/…; the MCP agent maps id→pageId
// and reads snippet/score/path. `rank`/`highlight` are null for substring-only
// hits (the web already falls back). Nothing the legacy web response carried is
// dropped.
export class SearchResultDto {
  id: string;
  // Alias of `id` for the MCP layer (it addresses pages by pageId).
  pageId: string;
  slugId: string;
  icon: string;
  title: string;
  space?: Partial<Space>;
  creatorId: string;
  createdAt: Date;
  updatedAt: Date;
  // ts_rank_cd of the FTS branch; null for substring-only hits.
  rank: number | null;
  // ts_headline marked HTML; null for substring-only hits.
  highlight: string | null;
  // Plain windowed snippet around the match (empty for titleOnly).
  snippet: string;
  // Ancestor titles root → direct parent ([] for a root page).
  path: string[];
  // Per-response ordering proxy (falls back to rank).
  score: number;
  // Which fields matched: 'title' and/or 'text'.
  matchedFields: string[];
  // Which parsed positive/required terms this hit matched.
  matchedTerms: string[];
}

// The paginated envelope (A5). `total` is the EXACT permission-filtered count of
// pages matching the positive lexical query (fail-closed). `hasMore` is true when
// more results exist WITHIN the fusion window; `truncatedAtCap` signals the match
// set exceeded CANDIDATE_CAP and the tail is unreachable by pagination.
export class SearchResponseDto {
  items: SearchResultDto[];
  total: number;
  hasMore: boolean;
  truncatedAtCap: boolean;
  offset: number;
  query: {
    raw: string;
    parsed: {
      positive: string[];
      required: string[];
      excluded: string[];
      reason?: string;
    };
    mode: 'or' | 'and';
    match: string;
  };
}
