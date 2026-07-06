import type { UIMessage } from "@ai-sdk/react";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * Pure decisions for the resumable-SSE resume machinery (#184 phase 1.5). A tab
 * that reopens a chat whose agent run is still going attaches to the server's
 * run-stream registry (replay + live tail) instead of polling snapshots; these
 * small predicates decide WHICH tail is safe to resume and how to seed the store,
 * extracted so they can be unit-tested in isolation.
 */

/**
 * A STREAMING tail: the last persisted row is an assistant row still marked
 * `status === 'streaming'`. Such a tail is stripped from the seed and rebuilt by
 * the replay (`expect=live`), since the SDK's `text-start` always pushes a new
 * part and replaying over a seeded in-progress row would duplicate its text.
 */
export function isStreamingTail(rows: IAiChatMessageRow[]): boolean {
  const tail = rows[rows.length - 1];
  return !!tail && tail.role === "assistant" && tail.status === "streaming";
}

/**
 * A SETTLED assistant tail: the last row is an assistant row whose status is
 * anything OTHER than 'streaming'. A settled assistant tail must NEVER resume —
 * replaying a finished run into a store that already holds its message duplicates
 * parts (`text-start` always pushes a new part).
 */
export function isSettledAssistantTail(rows: IAiChatMessageRow[]): boolean {
  const tail = rows[rows.length - 1];
  return !!tail && tail.role === "assistant" && tail.status !== "streaming";
}

/**
 * Seed rows for `useChat`: return the rows unchanged, or without the last row when
 * `strip` is set (the streaming tail is stripped so the live replay rebuilds it
 * without duplicating parts).
 */
export function seedRows(
  rows: IAiChatMessageRow[],
  strip: boolean,
): IAiChatMessageRow[] {
  return strip ? rows.slice(0, -1) : rows;
}

/**
 * Merge an assistant message into the rendered list by id: replace the message
 * with the same id in place (the in-progress assistant row is already seeded from
 * history, so per-step growth replaces it), or append it when absent. Returns a
 * new array; the input is never mutated.
 */
export function mergeById(
  messages: UIMessage[],
  incoming: UIMessage | null | undefined,
): UIMessage[] {
  if (!incoming) return messages;
  const idx = messages.findIndex((m) => m.id === incoming.id);
  if (idx === -1) return [...messages, incoming];
  const next = messages.slice();
  next[idx] = incoming;
  return next;
}
