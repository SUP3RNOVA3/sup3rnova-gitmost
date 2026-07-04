import type { UIMessage } from "@ai-sdk/react";
import type { IAiChatRun } from "@/features/ai-chat/types/ai-chat.types.ts";

/**
 * Reconnect-and-live-follow helpers (#184). When a chat is reopened while its
 * agent run is STILL going, this tab is a PASSIVE OBSERVER: it did not start the
 * run here (no local SSE stream), so it catches up by POLLING the reconnect
 * endpoint (`POST /ai-chat/run`) and merging the run's incrementally-persisted
 * assistant message into the rendered thread. These are the small pure decisions
 * that machinery hangs off, extracted so they can be unit-tested in isolation
 * (mirrors how reindex polling / editor-sync-state are tested).
 */

/** How often to re-poll the reconnect endpoint while a run is ACTIVE. */
export const RUN_POLL_INTERVAL_MS = 2000;

// 'pending' and 'running' are the two ACTIVE statuses; 'succeeded' | 'failed' |
// 'aborted' are TERMINAL (and any unknown future status is treated as terminal,
// so a stale/odd value never polls forever).
const ACTIVE_STATUSES = new Set(["pending", "running"]);

/** Whether a run is still going (worth polling / merging live updates from). */
export function isRunActive(run: IAiChatRun | null | undefined): boolean {
  return !!run && ACTIVE_STATUSES.has(run.status);
}

/**
 * The TanStack Query `refetchInterval` value for the run query: poll every
 * {@link RUN_POLL_INTERVAL_MS} while the run is active, and `false` (stop) once
 * it is terminal or there is no run. Polling is thus naturally bounded by the run
 * reaching a terminal status — no separate timeout cap is needed.
 */
export function runPollInterval(
  run: IAiChatRun | null | undefined,
): number | false {
  return isRunActive(run) ? RUN_POLL_INTERVAL_MS : false;
}

/**
 * Observer-vs-streamer decision. We render the polled run message (catch up +
 * keep advancing) ONLY when this tab is a passive observer: there IS a run AND
 * this tab is NOT the one locally streaming it (we reconnected, we didn't start
 * it here). When this tab is the streamer, the live SSE stream owns the view, so
 * we neither poll nor merge — avoiding a double-render fight. Terminal runs still
 * merge (so the final persisted output is shown on reopen); the poll itself is
 * stopped separately by {@link runPollInterval}.
 */
export function shouldObserveRun(
  run: IAiChatRun | null | undefined,
  localStreaming: boolean,
): boolean {
  return !!run && !localStreaming;
}

/**
 * Should the "stopping" latch — which suppresses the observer re-stream flash
 * after the user pressed Stop — be RELEASED now? All three must hold:
 *  - `stoppingRun`: we actually requested a stop (otherwise nothing to release);
 *  - `!isLocalStreaming`: this tab is NOT the local streamer. While we are the
 *    streamer the run query is disabled, so the observed `run` is not the run we
 *    are following — releasing the latch then would re-open the flash for the
 *    current turn the instant we switch to observer role;
 *  - the observed `run` EXISTS and has reached a TERMINAL status.
 *
 * The null / still-active `run` case is the #234 F4 invariant. On Stop the stale
 * PREVIOUS-turn run is removed from the query cache (`removeQueries`), so `run`
 * is null until the CURRENT turn's run is re-fetched fresh; a null or active run
 * therefore HOLDS the latch, so it can only ever clear against the current turn's
 * OWN terminal run — never a stale cached one. (The cache removal itself is
 * integration-level in AiChatWindow; this predicate encodes the decision given
 * whatever run is currently observed, and a stale terminal run is
 * indistinguishable from a current terminal run at the predicate level — hence
 * the cache removal is what guarantees only the current run is ever passed here.)
 */
export function shouldClearStoppingLatch(args: {
  stoppingRun: boolean;
  run: IAiChatRun | null | undefined;
  isLocalStreaming: boolean;
}): boolean {
  const { stoppingRun, run, isLocalStreaming } = args;
  if (!stoppingRun || isLocalStreaming) return false;
  return !!run && !isRunActive(run);
}

/**
 * Should the "stopping" latch be RELEASED by the run-query ERROR safety-net?
 * (#234 F7 — a NEW path of the same re-stream flash the F4 latch exists to
 * prevent.) After Stop, `handleServerStop` clears the run cache; the terminal
 * effect then holds the latch via `if (!run) return` until the CURRENT turn's run
 * is fetched fresh. If that refetch instead ERRORS permanently, `run` stays null,
 * its status-keyed refetchInterval is off, and nothing would ever observe a
 * terminal run — freezing the view with the observer merge suppressed. This
 * safety-net cures ONLY that genuine permanent-null-freeze.
 *
 * All four must hold:
 *  - `stoppingRun`: we actually requested a stop (otherwise nothing to release);
 *  - `!isLocalStreaming`: this tab is NOT the local streamer (same reason as
 *    {@link shouldClearStoppingLatch});
 *  - `runQueryFailed`: the run query is in its error state (TanStack Query v5 with
 *    retry:false — isError);
 *  - `!isRunActive(run)`: the observed `run` is NOT an active (pending/running)
 *    held run. This is the F7 gate. In TanStack Query v5 the query's `data` is
 *    RETAINED on error, so `runQueryFailed` can be true while `run` is STILL an
 *    ACTIVE run (a single transient GET-run failure in the window between Stop and
 *    settle). Without this gate a transient error would release the latch early —
 *    re-opening the observer merge and flashing the growing detached run over the
 *    frozen row (exactly the F4 flash). Gating on the run NOT being active means we
 *    only ever cure the permanent-null-freeze (`run === null`, so
 *    `isRunActive(null)` is false), never release against an active run.
 *
 * (A terminal `run` also satisfies `!isRunActive(run)`; clearing then is harmless
 * — the terminal effect's {@link shouldClearStoppingLatch} already clears the
 * latch for a terminal run, so this only ever agrees with it, never conflicts.)
 *
 * INVARIANT (do not break): clearing the latch on the `run === null` branch is safe
 * ONLY because the run query's `refetchInterval` (see {@link runPollInterval}) stops
 * polling when the data is empty — so after we clear on null+error there is no
 * subsequent auto-poll that could return a still-active detached run and re-open the
 * merge. If `refetchInterval` is ever changed to keep polling on `run === null`/on
 * error, this null-branch clear would re-open the F7 flash through the null path.
 * Do not change the run query's refetchInterval without re-checking this path.
 */
export function shouldClearLatchOnQueryError(args: {
  stoppingRun: boolean;
  isLocalStreaming: boolean;
  runQueryFailed: boolean;
  run: IAiChatRun | null | undefined;
}): boolean {
  const { stoppingRun, isLocalStreaming, runQueryFailed, run } = args;
  return (
    stoppingRun && !isLocalStreaming && runQueryFailed && !isRunActive(run)
  );
}

/**
 * Merge an observed assistant message into the rendered list: replace the message
 * with the same id in place (the in-progress assistant row is already seeded from
 * history, so per-step growth replaces it), or append it when absent. Returns a
 * new array; the input is never mutated.
 */
export function mergeObservedMessage(
  messages: UIMessage[],
  observed: UIMessage | null | undefined,
): UIMessage[] {
  if (!observed) return messages;
  const idx = messages.findIndex((m) => m.id === observed.id);
  if (idx === -1) return [...messages, observed];
  const next = messages.slice();
  next[idx] = observed;
  return next;
}
