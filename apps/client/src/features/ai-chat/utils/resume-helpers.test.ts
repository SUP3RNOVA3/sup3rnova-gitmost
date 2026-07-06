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
});
