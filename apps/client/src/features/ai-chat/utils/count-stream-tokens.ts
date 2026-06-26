/**
 * Live token ESTIMATION for a streaming AI-chat turn.
 *
 * No provider streams exact per-token usage mid-stream, so the live number is a
 * CLIENT ESTIMATE (chars/≈4 heuristic). It powers the chat body's
 * `Thinking… · N tokens` indicator (see `ReasoningBlock`), which reconciles to
 * the authoritative server usage once it lands. Pure + unit-testable: it never
 * runs a real BPE tokenizer (that would be O(n²) on the hot path, bloat the
 * bundle, and be wrong for Gemini/Ollama anyway).
 *
 * The former header-badge `liveTurnTokens()` split was removed with #189 (the
 * header badge now shows the stable "current / max" context size, not a live
 * per-turn counter); the live feedback remains in `ReasoningBlock`.
 */

/**
 * Rough token estimate for a piece of text using the standard chars/≈4 heuristic.
 * Returns 0 for empty/whitespace-free-of-content input, and ceils so any
 * non-empty text counts as at least one token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
