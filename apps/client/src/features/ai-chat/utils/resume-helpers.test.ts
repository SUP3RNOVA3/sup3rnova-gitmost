import { describe, it, expect } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";
import {
  isStreamingTail,
  isSettledAssistantTail,
  seedRows,
  mergeById,
} from "./resume-helpers.ts";

function row(
  id: string,
  role: string,
  status?: string,
): IAiChatMessageRow {
  return { id, role, content: "", status, createdAt: "2026-01-01T00:00:00Z" };
}

function makeMsg(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("isStreamingTail", () => {
  it("is true when the last row is a streaming assistant row", () => {
    expect(
      isStreamingTail([row("u1", "user"), row("a1", "assistant", "streaming")]),
    ).toBe(true);
  });

  it("is false for a settled assistant tail", () => {
    expect(isStreamingTail([row("a1", "assistant", "succeeded")])).toBe(false);
    expect(isStreamingTail([row("a1", "assistant")])).toBe(false);
  });

  it("is false when the tail is a user row or the list is empty", () => {
    expect(isStreamingTail([row("u1", "user")])).toBe(false);
    expect(isStreamingTail([])).toBe(false);
  });
});

describe("isSettledAssistantTail", () => {
  it("is true for an assistant tail whose status is not streaming", () => {
    expect(isSettledAssistantTail([row("a1", "assistant", "succeeded")])).toBe(
      true,
    );
    expect(isSettledAssistantTail([row("a1", "assistant")])).toBe(true);
    expect(isSettledAssistantTail([row("a1", "assistant", "aborted")])).toBe(
      true,
    );
  });

  it("is false for a streaming assistant tail", () => {
    expect(isSettledAssistantTail([row("a1", "assistant", "streaming")])).toBe(
      false,
    );
  });

  it("is false when the tail is a user row or the list is empty", () => {
    expect(isSettledAssistantTail([row("u1", "user")])).toBe(false);
    expect(isSettledAssistantTail([])).toBe(false);
  });
});

describe("seedRows", () => {
  const rows = [row("u1", "user"), row("a1", "assistant", "streaming")];

  it("returns the rows unchanged when not stripping", () => {
    expect(seedRows(rows, false)).toBe(rows);
  });

  it("drops the last row when stripping", () => {
    const seeded = seedRows(rows, true);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].id).toBe("u1");
  });

  it("returns an empty list when stripping a single-row list", () => {
    expect(seedRows([row("a1", "assistant", "streaming")], true)).toHaveLength(
      0,
    );
  });
});

describe("mergeById", () => {
  it("replaces the message with the same id in place (per-step growth)", () => {
    const prev = [makeMsg("u1", "hi"), makeMsg("a1", "step 1")];
    const incoming = makeMsg("a1", "step 1\nstep 2");
    const next = mergeById(prev, incoming);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(incoming);
    expect(next[0]).toBe(prev[0]); // untouched
    expect(next).not.toBe(prev); // new array (never mutates input)
  });

  it("appends when the incoming message is not yet present", () => {
    const prev = [makeMsg("u1", "hi")];
    const incoming = makeMsg("a1", "first token");
    const next = mergeById(prev, incoming);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(incoming);
  });

  it("returns the original list unchanged when there is nothing to merge", () => {
    const prev = [makeMsg("u1", "hi")];
    expect(mergeById(prev, null)).toBe(prev);
    expect(mergeById(prev, undefined)).toBe(prev);
  });

  // #491 CONTRACT: the delta poll's overlap window GUARANTEES the same row is
  // re-delivered across close polls, so merging must be IDEMPOTENT by id — merging
  // the same row (or an equal-length list of rows) twice must not duplicate or
  // reorder. This is the property the whole delta-poll design leans on; a
  // regression here would re-introduce duplicate assistant bubbles on every poll.
  it("is idempotent by id: re-merging the same row does not duplicate or reorder", () => {
    const seed = [makeMsg("u1", "hi"), makeMsg("a1", "step 1")];
    const repeat = makeMsg("a1", "step 1"); // the SAME row the overlap re-delivers
    const once = mergeById(seed, repeat);
    const twice = mergeById(once, repeat);
    const thrice = mergeById(twice, repeat);
    // Length is stable (no growth), order is stable (user then assistant).
    expect(once.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(twice.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(thrice.map((m) => m.id)).toEqual(["u1", "a1"]);
    // The repeated merge converges: the row is replaced in place, never appended.
    expect(twice[1]).toBe(repeat);
  });

  it("is idempotent across a batch of repeated + grown rows (delta re-delivery)", () => {
    // A delta poll re-delivers a1 (unchanged) and a2 (grown one step). Applying the
    // batch twice must equal applying it once — the poll can re-send either.
    const start = [makeMsg("u1", "hi"), makeMsg("a1", "done")];
    const batch = [makeMsg("a1", "done"), makeMsg("a2", "grown step 2")];
    const apply = (list: typeof start) =>
      batch.reduce((acc, row) => mergeById(acc, row), list);
    const once = apply(start);
    const twice = apply(once);
    expect(once.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
    expect(twice.map((m) => m.id)).toEqual(["u1", "a1", "a2"]);
    expect(twice).toEqual(once);
  });
});
