export const HISTORY_INTERVAL = 5 * 60 * 1000;
export const HISTORY_FAST_INTERVAL = 60 * 1000;
export const HISTORY_FAST_THRESHOLD = 5 * 60 * 1000;

// #348 — debounce window for the per-page RAG re-embed job. Repeated saves
// within this window collapse to a single delayed job (coalesced by a stable
// jobId), so active editing does not pile up expensive re-embeds (external API
// + page_embeddings rewrite, concurrency 1). The worker reads the CURRENT page
// state at run time, so the last content within the window wins.
export const EMBED_DEBOUNCE_MS = 30 * 1000;
