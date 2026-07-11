/**
 * History-replay token budget (#490).
 *
 * The whole persisted conversation is replayed to the provider on EVERY turn, so
 * a long chat eventually exceeds the model's context window and the provider 400s
 * on every turn — terminally (the chat "bricks"). This module bounds the replayed
 * history at REPLAY TIME only: it never mutates what is persisted (the DB stays
 * the full record), and its output is a deterministic, byte-stable function of its
 * input so the trimmed prefix is identical turn to turn (provider prompt-cache
 * friendliness — real money on long chats).
 *
 * The PRIMARY signal is the provider's own fact: `metadata.contextTokens` from the
 * last turn. The chars-based {@link estimateTokens} (shared with the client) is
 * used only for the DELTA of not-yet-sent messages, to decide WHAT to trim, and as
 * the fallback for chats with no usage yet.
 */
import type { ModelMessage } from 'ai';
import { estimateTokens } from '@docmost/token-estimate';

/** Flat default budget when no context window is configured (tokens). */
export const REPLAY_BUDGET_DEFAULT_TOKENS = 100_000;
/** Fraction of a configured context window used as the budget. */
export const REPLAY_BUDGET_WINDOW_FRACTION = 0.7;
/**
 * Fraction of the normal budget used for the REACTIVE re-trim after a provider
 * context-overflow 400 — the preventive estimate under-counted, so cut harder.
 */
export const REPLAY_AGGRESSIVE_FRACTION = 0.5;
/**
 * Turns (a user message + its assistant/tool replies) kept FULL at the tail,
 * including the current one — never trimmed. Older turns are compacted first.
 */
export const REPLAY_KEEP_RECENT_TURNS = 4;
/** Leading chars kept from a truncated old tool output. */
export const REPLAY_TOOL_OUTPUT_HEAD = 800;
/** Trailing chars kept from a truncated old tool output. */
export const REPLAY_TOOL_OUTPUT_TAIL = 300;
/** Marker inserted where an old tool output was truncated for replay. */
export const REPLAY_TRUNCATION_MARKER =
  '[…truncated for replay; call the tool again to read the full output]';
/** Marker for a whole old turn collapsed to its text. */
export const REPLAY_TURN_COLLAPSED_MARKER =
  '[earlier tool activity omitted for replay]';

export interface ReplayBudget {
  /** Token threshold above which replay history is trimmed; `null` = OFF. */
  thresholdTokens: number | null;
  /** True when the flat default was used (no context window configured). */
  usedDefault: boolean;
}

/**
 * Resolve the replay budget from the RAW stored `chatContextWindow` (text/number).
 *  - a positive value  -> `min(default, floor(fraction × window))`
 *  - explicit `0`       -> OFF (admin opt-out; `null` threshold)
 *  - unset/empty/invalid-> the flat default (still protects — the installations
 *    that hit terminal overflow are exactly the ones that never set a window)
 *
 * Note the raw value is needed because the parsed `chatContextWindow` collapses
 * both `0` and unset to `undefined`, which would erase the explicit off-switch.
 */
export function resolveReplayBudget(rawContextWindow: unknown): ReplayBudget {
  let n: number | undefined;
  if (typeof rawContextWindow === 'number') {
    n = rawContextWindow;
  } else if (typeof rawContextWindow === 'string') {
    const t = rawContextWindow.trim();
    n = t === '' ? undefined : Number(t);
  }
  // Unset / empty / non-numeric / negative -> flat default (the protective case).
  if (n === undefined || !Number.isFinite(n) || n < 0) {
    return { thresholdTokens: REPLAY_BUDGET_DEFAULT_TOKENS, usedDefault: true };
  }
  // Explicit 0 -> off-switch.
  if (n === 0) {
    return { thresholdTokens: null, usedDefault: false };
  }
  return {
    thresholdTokens: Math.min(
      REPLAY_BUDGET_DEFAULT_TOKENS,
      Math.floor(REPLAY_BUDGET_WINDOW_FRACTION * n),
    ),
    usedDefault: false,
  };
}

/**
 * True when a provider error is a CONTEXT-OVERFLOW rejection (the prompt exceeds
 * the model's window). Providers surface this as an HTTP 400 with a recognizable
 * message; match both the status and the message patterns robustly across
 * OpenAI-compatible / Anthropic / Gemini wordings, since the exact shape varies.
 */
export function isContextOverflowError(error: unknown): boolean {
  const status = extractStatus(error);
  const msg = extractMessage(error).toLowerCase();
  // Message patterns seen across providers for "prompt too long".
  const overflowPattern =
    /context (?:length|window)|maximum context|too many tokens|too large for|reduce the length|prompt is too long|input (?:is )?too long|exceeds? the (?:maximum )?(?:context|token)|maximum.*tokens|string too long/;
  if (!overflowPattern.test(msg)) return false;
  // A 400/413 with an overflow-shaped message is an overflow. Some providers
  // omit/rewrite the status, so accept the message match when the status is
  // unknown, but reject it for auth/rate-limit statuses that never mean overflow.
  if (status === 400 || status === 413) return true;
  if (status === 401 || status === 403 || status === 429) return false;
  return true;
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  for (const k of ['statusCode', 'status']) {
    const v = e[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  }
  // Nested (e.g. { response: { status } } / { cause: { statusCode } }).
  for (const k of ['response', 'cause', 'data']) {
    const nested = e[k];
    if (nested && typeof nested === 'object') {
      const s = extractStatus(nested);
      if (s !== undefined) return s;
    }
  }
  return undefined;
}

function extractMessage(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    // Include nested causes (provider libs wrap the real body in `cause`).
    const cause = (error as { cause?: unknown }).cause;
    return `${error.message} ${cause ? extractMessage(cause) : ''}`;
  }
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of ['message', 'error', 'body', 'responseBody', 'data']) {
      const v = e[k];
      if (typeof v === 'string') parts.push(v);
      else if (v && typeof v === 'object') parts.push(extractMessage(v));
    }
    return parts.join(' ');
  }
  return String(error);
}

/** Rough token size of a ModelMessage array via the shared chars estimator. */
export function estimateMessagesTokens(
  messages: ReadonlyArray<ModelMessage>,
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(serializeContent(m.content));
  }
  return total;
}

function serializeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content) ?? '';
  } catch {
    return '';
  }
}

/** Deep JSON string of an arbitrary value, bounded so estimation never throws. */
function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface TrimResult {
  messages: ModelMessage[];
  /** Whether any trimming was applied. */
  trimmed: boolean;
  /** Estimated tokens of the returned messages (chars-based). */
  estimatedTokens: number;
}

/**
 * Bound the replayed history to `budgetTokens`, deterministically. Returns the
 * SAME array reference (no copy) when nothing needs trimming, so the common case
 * is free and byte-identical. Trimming order (spec #490):
 *   1. truncate OLD turns' tool outputs (head+tail + marker) — the bulk of the size
 *   2. mechanically collapse the OLDEST turns to their text (concatenation, no LLM)
 *   3. the current + last {@link REPLAY_KEEP_RECENT_TURNS} turns stay FULL
 *
 * `budgetTokens === null` disables trimming. `priorContextTokens` (the provider's
 * fact from last turn) short-circuits the decision: when it is known and already
 * under budget we skip trimming even if the char-estimate is higher (the provider
 * count is authoritative). The char-estimate drives WHAT to cut.
 */
export function trimHistoryForReplay(
  messages: ModelMessage[],
  budgetTokens: number | null,
  priorContextTokens?: number,
): TrimResult {
  if (budgetTokens == null) {
    return { messages, trimmed: false, estimatedTokens: 0 };
  }
  const estimated = estimateMessagesTokens(messages);
  // Decision signal: prefer the provider's fact (last turn's contextTokens) plus
  // the estimated delta of the messages appended since; fall back to the pure
  // char-estimate for a chat with no usage yet.
  const projected =
    priorContextTokens != null
      ? Math.max(priorContextTokens, estimated)
      : estimated;
  if (projected <= budgetTokens) {
    return { messages, trimmed: false, estimatedTokens: estimated };
  }

  // The tail we always keep full: from the Nth-from-last user message onward.
  const boundary = recentBoundaryIndex(messages, REPLAY_KEEP_RECENT_TURNS);
  const tail = messages.slice(boundary);
  let head = messages.slice(0, boundary).map(cloneMessage);

  // Phase 1: truncate old tool outputs.
  for (const m of head) {
    if (m.role === 'tool') truncateToolMessage(m);
  }
  let out = [...head, ...tail];
  let est = estimateMessagesTokens(out);
  if (est <= budgetTokens) {
    return { messages: out, trimmed: true, estimatedTokens: est };
  }

  // Phase 2: collapse the oldest turns (in `head`) to their text, one at a time,
  // from the oldest, until we fit or the whole head is collapsed.
  const turns = splitTurns(head);
  const collapsed: ModelMessage[] = [];
  let i = 0;
  for (; i < turns.length; i++) {
    if (est <= budgetTokens) break;
    collapsed.push(...collapseTurn(turns[i]));
    // Re-estimate the whole prospective output.
    const remaining = turns.slice(i + 1).flat();
    out = [...collapsed, ...remaining, ...tail];
    est = estimateMessagesTokens(out);
  }
  // Include any turns we didn't need to collapse.
  const remaining = turns.slice(i).flat();
  out = [...collapsed, ...remaining, ...tail];
  est = estimateMessagesTokens(out);
  return { messages: out, trimmed: true, estimatedTokens: est };
}

/** Index of the first message of the Nth-from-last user turn (0 if fewer). */
function recentBoundaryIndex(
  messages: ReadonlyArray<ModelMessage>,
  keepTurns: number,
): number {
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIdx.push(i);
  }
  if (userIdx.length <= keepTurns) return 0;
  return userIdx[userIdx.length - keepTurns];
}

/** Split a message list into turns; each turn starts at a `user` message. */
function splitTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  for (const m of messages) {
    if (m.role === 'user' || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  return turns;
}

/**
 * Collapse a whole turn to its plain text (mechanical concatenation, not an LLM
 * summary). Keeps the user message; replaces the assistant/tool messages with a
 * single assistant text message = the assistant's concatenated text + a marker
 * when tool activity was dropped. Dropping BOTH the tool-call and tool-result
 * parts together keeps the rebuilt history balanced (no unpaired calls).
 */
function collapseTurn(turn: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let assistantText = '';
  let hadTools = false;
  for (const m of turn) {
    if (m.role === 'user') {
      out.push(m);
    } else if (m.role === 'assistant') {
      const { text, tools } = extractAssistantText(m.content);
      assistantText += text;
      hadTools = hadTools || tools;
    } else if (m.role === 'tool') {
      hadTools = true;
    } else {
      out.push(m);
    }
  }
  const note =
    (assistantText ? assistantText.trimEnd() : '') +
    (hadTools
      ? `${assistantText ? '\n\n' : ''}${REPLAY_TURN_COLLAPSED_MARKER}`
      : '');
  if (note) out.push({ role: 'assistant', content: note } as ModelMessage);
  return out;
}

function extractAssistantText(content: unknown): {
  text: string;
  tools: boolean;
} {
  if (typeof content === 'string') return { text: content, tools: false };
  if (!Array.isArray(content)) return { text: '', tools: false };
  let text = '';
  let tools = false;
  for (const part of content) {
    const type = (part as { type?: string })?.type;
    if (type === 'text') text += (part as { text?: string }).text ?? '';
    else if (type === 'tool-call') tools = true;
  }
  return { text, tools };
}

/** Truncate every tool-result output in a `tool` message to head+tail+marker. */
function truncateToolMessage(message: ModelMessage): void {
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    const p = part as { type?: string; output?: { type?: string; value?: unknown } };
    if (p.type !== 'tool-result' && p.type !== 'tool-error') continue;
    if (!p.output) continue;
    const raw = stringifyValue(p.output.value);
    const budget = REPLAY_TOOL_OUTPUT_HEAD + REPLAY_TOOL_OUTPUT_TAIL;
    if (raw.length <= budget + REPLAY_TRUNCATION_MARKER.length) continue;
    const truncated =
      raw.slice(0, REPLAY_TOOL_OUTPUT_HEAD) +
      `\n${REPLAY_TRUNCATION_MARKER}\n` +
      raw.slice(raw.length - REPLAY_TOOL_OUTPUT_TAIL);
    // Represent the shrunk output as a text output (a valid tool-result output).
    p.output = { type: 'text', value: truncated };
  }
}

/** Shallow-ish clone so trimming never mutates the caller's (persisted-derived)
 *  message objects — only the OLD region is cloned before it is edited. */
function cloneMessage(m: ModelMessage): ModelMessage {
  if (typeof m.content === 'string') return { ...m };
  return {
    ...m,
    content: (m.content as unknown[]).map((p) =>
      p && typeof p === 'object' ? { ...(p as object) } : p,
    ),
  } as ModelMessage;
}
