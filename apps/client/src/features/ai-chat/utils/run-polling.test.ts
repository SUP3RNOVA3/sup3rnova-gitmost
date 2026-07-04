import { describe, it, expect } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import type { IAiChatRun } from "@/features/ai-chat/types/ai-chat.types.ts";
import {
  RUN_POLL_INTERVAL_MS,
  isRunActive,
  runPollInterval,
  shouldObserveRun,
  shouldClearStoppingLatch,
  shouldClearLatchOnQueryError,
  mergeObservedMessage,
} from "./run-polling.ts";

function makeRun(status: string): IAiChatRun {
  return { id: "run-1", chatId: "c1", status };
}

function makeMsg(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("isRunActive", () => {
  it("treats pending and running as active", () => {
    expect(isRunActive(makeRun("pending"))).toBe(true);
    expect(isRunActive(makeRun("running"))).toBe(true);
  });

  it("treats terminal / unknown / nullish as not active", () => {
    expect(isRunActive(makeRun("succeeded"))).toBe(false);
    expect(isRunActive(makeRun("failed"))).toBe(false);
    expect(isRunActive(makeRun("aborted"))).toBe(false);
    expect(isRunActive(makeRun("weird-future-status"))).toBe(false);
    expect(isRunActive(null)).toBe(false);
    expect(isRunActive(undefined)).toBe(false);
  });
});

describe("runPollInterval (the refetchInterval helper)", () => {
  it("returns 2000ms while the run is pending/running", () => {
    expect(runPollInterval(makeRun("pending"))).toBe(RUN_POLL_INTERVAL_MS);
    expect(runPollInterval(makeRun("running"))).toBe(RUN_POLL_INTERVAL_MS);
    expect(RUN_POLL_INTERVAL_MS).toBe(2000);
  });

  it("returns false (stop polling) once the run is terminal", () => {
    expect(runPollInterval(makeRun("succeeded"))).toBe(false);
    expect(runPollInterval(makeRun("failed"))).toBe(false);
    expect(runPollInterval(makeRun("aborted"))).toBe(false);
  });

  it("returns false (no polling) when there is no run", () => {
    expect(runPollInterval(null)).toBe(false);
    expect(runPollInterval(undefined)).toBe(false);
  });
});

describe("shouldObserveRun (observer-vs-streamer decision)", () => {
  it("observes an active run when this tab is NOT the local streamer", () => {
    expect(shouldObserveRun(makeRun("running"), false)).toBe(true);
    expect(shouldObserveRun(makeRun("pending"), false)).toBe(true);
  });

  it("observes a terminal run too (so the final output shows on reopen)", () => {
    expect(shouldObserveRun(makeRun("succeeded"), false)).toBe(true);
  });

  it("does NOT observe when this tab IS the streamer (no double-render)", () => {
    expect(shouldObserveRun(makeRun("running"), true)).toBe(false);
    expect(shouldObserveRun(makeRun("succeeded"), true)).toBe(false);
  });

  it("does NOT observe when there is no run", () => {
    expect(shouldObserveRun(null, false)).toBe(false);
    expect(shouldObserveRun(undefined, false)).toBe(false);
  });
});

describe("shouldClearStoppingLatch (#234 latch-release decision)", () => {
  // The one case the latch SHOULD clear: we requested a stop, we are the passive
  // observer (not streaming), and the CURRENT run is terminal.
  it("clears only when stopping, observing, and the run is terminal", () => {
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: makeRun("aborted"),
        isLocalStreaming: false,
      }),
    ).toBe(true);
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: makeRun("succeeded"),
        isLocalStreaming: false,
      }),
    ).toBe(true);
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: makeRun("failed"),
        isLocalStreaming: false,
      }),
    ).toBe(true);
  });

  // Round-3 regression: clearing while THIS tab is still the local streamer would
  // re-open the flash for the current turn the moment we switch to observer role.
  // A predicate lacking the streaming gate would (wrongly) return true here.
  it("does NOT clear while this tab is the local streamer", () => {
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: makeRun("aborted"),
        isLocalStreaming: true,
      }),
    ).toBe(false);
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: makeRun("succeeded"),
        isLocalStreaming: true,
      }),
    ).toBe(false);
  });

  // The detached run keeps growing after a local abort — while it is still
  // active the latch MUST hold so the observer merge stays suppressed.
  it("does NOT clear while the run is still active", () => {
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: makeRun("running"),
        isLocalStreaming: false,
      }),
    ).toBe(false);
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: makeRun("pending"),
        isLocalStreaming: false,
      }),
    ).toBe(false);
  });

  // #234 F4: on Stop the stale PREVIOUS-turn run is removed from the cache, so the
  // observed `run` is null until the current turn's run is fetched fresh. A null
  // run HOLDS the latch — it can never clear against the just-removed stale run,
  // only against the current turn's own terminal run once observed.
  it("does NOT clear against a removed/absent run (F4 stale-run guard)", () => {
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: null,
        isLocalStreaming: false,
      }),
    ).toBe(false);
    expect(
      shouldClearStoppingLatch({
        stoppingRun: true,
        run: undefined,
        isLocalStreaming: false,
      }),
    ).toBe(false);
  });

  it("does NOT clear when no stop was requested", () => {
    expect(
      shouldClearStoppingLatch({
        stoppingRun: false,
        run: makeRun("aborted"),
        isLocalStreaming: false,
      }),
    ).toBe(false);
  });
});

describe("shouldClearLatchOnQueryError (#234 F7 error-safety-net decision)", () => {
  // This guards the REAL anti-flash decision the component's run-query-error
  // safety-net effect uses (ai-chat-window.tsx wires the effect to THIS helper,
  // not a copy — so the test is non-vacuous vs the live code).

  // (b) The F7 hole: a TRANSIENT run-query error while `run` is STILL ACTIVE must
  // NOT clear the latch. TanStack Query v5 retains `data` on error, so
  // runQueryFailed can be true while the held run is still pending/running.
  // Against the PRE-F7 condition (without `!isRunActive(run)`) this would return
  // true — so this assertion fails on the buggy code (non-vacuous).
  it("does NOT clear on a transient error while the run is still ACTIVE (F7)", () => {
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: true,
        isLocalStreaming: false,
        runQueryFailed: true,
        run: makeRun("running"),
      }),
    ).toBe(false);
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: true,
        isLocalStreaming: false,
        runQueryFailed: true,
        run: makeRun("pending"),
      }),
    ).toBe(false);
  });

  // (a) The genuine permanent-null-freeze: run cache cleared by removeQueries +
  // the refetch keeps ERRORING, so `run === null`. This is the ONLY case the
  // safety-net exists to cure — it MUST clear so the frozen view resumes.
  it("clears on a permanent error when the run is null (permanent-null-freeze)", () => {
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: true,
        isLocalStreaming: false,
        runQueryFailed: true,
        run: null,
      }),
    ).toBe(true);
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: true,
        isLocalStreaming: false,
        runQueryFailed: true,
        run: undefined,
      }),
    ).toBe(true);
  });

  // A TERMINAL run also satisfies `!isRunActive`; clearing then is harmless — the
  // terminal effect (shouldClearStoppingLatch) already clears for a terminal run,
  // so this only ever agrees with it. Asserted so the (c) reasoning is pinned.
  it("clears on an error when the run is terminal (harmless, agrees with terminal effect)", () => {
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: true,
        isLocalStreaming: false,
        runQueryFailed: true,
        run: makeRun("aborted"),
      }),
    ).toBe(true);
  });

  it("does NOT clear without an actual query error", () => {
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: true,
        isLocalStreaming: false,
        runQueryFailed: false,
        run: null,
      }),
    ).toBe(false);
  });

  it("does NOT clear while this tab is the local streamer", () => {
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: true,
        isLocalStreaming: true,
        runQueryFailed: true,
        run: null,
      }),
    ).toBe(false);
  });

  it("does NOT clear when no stop was requested", () => {
    expect(
      shouldClearLatchOnQueryError({
        stoppingRun: false,
        isLocalStreaming: false,
        runQueryFailed: true,
        run: null,
      }),
    ).toBe(false);
  });
});

describe("mergeObservedMessage", () => {
  it("replaces the message with the same id in place (per-step growth)", () => {
    const prev = [makeMsg("u1", "hi"), makeMsg("a1", "step 1")];
    const observed = makeMsg("a1", "step 1\nstep 2");
    const next = mergeObservedMessage(prev, observed);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(observed);
    expect(next[0]).toBe(prev[0]); // untouched
    expect(next).not.toBe(prev); // new array (never mutates input)
  });

  it("appends when the observed message is not yet present", () => {
    const prev = [makeMsg("u1", "hi")];
    const observed = makeMsg("a1", "first token");
    const next = mergeObservedMessage(prev, observed);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(observed);
  });

  it("returns the original list unchanged when there is nothing to merge", () => {
    const prev = [makeMsg("u1", "hi")];
    expect(mergeObservedMessage(prev, null)).toBe(prev);
    expect(mergeObservedMessage(prev, undefined)).toBe(prev);
  });
});
