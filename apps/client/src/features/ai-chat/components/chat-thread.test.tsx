import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// Shared, hoisted mock state so the @ai-sdk/react and "ai" module mocks (hoisted
// above the imports) can expose the captured useChat callbacks / transport and
// the spies back to the test body.
const h = vi.hoisted(() => ({
  state: {
    status: "streaming" as string,
    onFinish: null as null | ((arg: Record<string, unknown>) => void),
    sendMessage: vi.fn(),
    stop: vi.fn(),
    setMessages: vi.fn(),
    transport: null as null | {
      prepareSendMessagesRequest: (arg: {
        messages: unknown[];
        body: Record<string, unknown>;
      }) => { body: Record<string, unknown> };
    },
  },
}));

// Mock useChat: capture onFinish, return the spies and the controllable status.
vi.mock("@ai-sdk/react", () => ({
  useChat: (opts: { onFinish?: (arg: Record<string, unknown>) => void }) => {
    h.state.onFinish = opts.onFinish ?? null;
    return {
      messages: [],
      sendMessage: h.state.sendMessage,
      status: h.state.status,
      stop: h.state.stop,
      error: null,
      // #184: ChatThread reads setMessages to merge a polled observer run.
      setMessages: h.state.setMessages,
    };
  },
}));

// Mock "ai": deterministic ids + a transport that records its options so the test
// can invoke prepareSendMessagesRequest and assert the `interrupted` flag.
vi.mock("ai", () => {
  let counter = 0;
  return {
    generateId: () => `gid-${counter++}`,
    DefaultChatTransport: class {
      constructor(opts: {
        prepareSendMessagesRequest: (arg: {
          messages: unknown[];
          body: Record<string, unknown>;
        }) => { body: Record<string, unknown> };
      }) {
        h.state.transport = opts;
      }
    },
  };
});

// Stub the heavy children: MessageList (markdown/render) and ChatInput (the
// composer). The ChatInput stub exposes a button that queues a message, the only
// interaction this test needs to populate the queue while "streaming".
vi.mock("@/features/ai-chat/components/message-list.tsx", () => ({
  default: () => <div data-testid="message-list" />,
}));
vi.mock("@/features/ai-chat/components/chat-input.tsx", () => ({
  default: ({ onQueue }: { onQueue: (text: string) => void }) => (
    <button data-testid="queue-btn" onClick={() => onQueue("queued text")}>
      queue
    </button>
  ),
}));

import ChatThread from "./chat-thread";

function renderThread() {
  const onTurnFinished = vi.fn();
  render(
    <MantineProvider>
      <ChatThread chatId="c1" initialRows={[]} onTurnFinished={onTurnFinished} />
    </MantineProvider>,
  );
  return { onTurnFinished };
}

describe("ChatThread — send now (#198)", () => {
  beforeEach(() => {
    h.state.status = "streaming";
    h.state.onFinish = null;
    h.state.sendMessage.mockClear();
    h.state.stop.mockClear();
    h.state.transport = null;
  });

  it("aborts the current turn and resends the queued message on the abort", () => {
    renderThread();

    // Queue a message while the turn is streaming.
    fireEvent.click(screen.getByTestId("queue-btn"));
    const sendNowBtn = screen.getByLabelText("Send now");
    expect(sendNowBtn).toBeTruthy();

    // "Send now" interrupts the current turn (stop), but does NOT send yet —
    // the resend happens once the abort lands in onFinish.
    fireEvent.click(sendNowBtn);
    expect(h.state.stop).toHaveBeenCalledTimes(1);
    expect(h.state.sendMessage).not.toHaveBeenCalled();

    // The abort we triggered reaches onFinish: the promoted head is flushed.
    act(() => {
      h.state.onFinish?.({
        message: { id: "a", role: "assistant", parts: [] },
        isAbort: true,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
  });

  it("tags exactly the next send as interrupted (one-shot flag)", () => {
    renderThread();
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    const prep = h.state.transport!.prepareSendMessagesRequest;
    // The send right after "send now" carries interrupted: true...
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(true);
    // ...and only that one (the flag is read-and-cleared).
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(false);
  });

  it("sends immediately without an interrupt when not streaming", () => {
    h.state.status = "ready";
    renderThread();

    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    // No turn to interrupt: sent straight away, no abort, not flagged.
    expect(h.state.stop).not.toHaveBeenCalled();
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
    const prep = h.state.transport!.prepareSendMessagesRequest;
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(false);
  });
});

// The turn-end decision lives in the `onFinish` handler: given the terminal
// outcome of a turn (`isAbort` / `isDisconnect` / `isError`, or none = clean),
// it decides whether to CONTINUE (flush the next queued message) or END (leave
// the queue intact for the user), and which stop notice — if any — to show.
// `sendNow` is exercised above; these tests pin down the plain outcomes.
describe("ChatThread — turn-end decision (onFinish)", () => {
  beforeEach(() => {
    h.state.status = "streaming";
    h.state.onFinish = null;
    h.state.sendMessage.mockClear();
    h.state.stop.mockClear();
    h.state.transport = null;
  });

  // Drive a fresh onFinish with the given terminal flags after queueing a
  // message, and report both what the parent was told and whether the queue was
  // flushed (a resend to the sendMessage spy).
  function finishWith(flags: {
    isAbort?: boolean;
    isDisconnect?: boolean;
    isError?: boolean;
  }) {
    // Tear down any prior render so the loop-driven "every outcome" case does
    // not leave duplicate queue buttons in the DOM.
    cleanup();
    h.state.sendMessage.mockClear();
    const { onTurnFinished } = renderThread();
    // Populate the queue while the turn is streaming.
    fireEvent.click(screen.getByTestId("queue-btn"));
    act(() => {
      h.state.onFinish?.({
        message: { id: "a", role: "assistant", parts: [] },
        isAbort: false,
        isDisconnect: false,
        isError: false,
        ...flags,
      });
    });
    return { onTurnFinished };
  }

  it("CONTINUES — flushes the next queued message on a clean finish", () => {
    finishWith({});
    // Clean finish (no terminal flag): the queued message is auto-sent.
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
    // A clean finish shows no stop notice.
    expect(screen.queryByText("Response stopped.")).toBeNull();
  });

  it("ENDS — keeps the queue intact on a user abort and shows the stopped notice", () => {
    finishWith({ isAbort: true });
    // A plain Stop (not the sendNow interrupt path) must NOT auto-resend: the
    // queue is preserved for the user to decide.
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Response stopped.")).toBeTruthy();
  });

  it("ENDS — keeps the queue intact on a disconnect and shows the connection-lost notice", () => {
    finishWith({ isDisconnect: true });
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    expect(
      screen.getByText("Connection lost — the answer was interrupted."),
    ).toBeTruthy();
  });

  it("ENDS — keeps the queue intact on a stream error (no auto-retry, no stopped notice)", () => {
    finishWith({ isError: true });
    // Blindly retrying after a failure would be wrong; the queue is left alone.
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    // isError clears the neutral notice (the error banner covers this case).
    expect(screen.queryByText("Response stopped.")).toBeNull();
  });

  it("notifies the parent on EVERY terminal outcome", () => {
    // The chat-list refresh / new-chat id adoption must run on success and on
    // every failure path alike.
    for (const flags of [
      {},
      { isAbort: true },
      { isDisconnect: true },
      { isError: true },
    ]) {
      const { onTurnFinished } = finishWith(flags);
      expect(onTurnFinished).toHaveBeenCalled();
    }
  });
});

// #184 passive-observer merge: when reconnecting to a still-running run, the
// parent feeds the polled run message via `observedRow`; ChatThread merges it via
// setMessages — but ONLY when this tab is NOT itself streaming (the streamer's
// SSE owns the view, so a stale observedRow must never overwrite it).
describe("ChatThread — observer run merge (#184)", () => {
  beforeEach(() => {
    h.state.onFinish = null;
    h.state.setMessages.mockReset();
  });

  const observedRow = {
    id: "a-run",
    role: "assistant",
    content: "step 1\nstep 2",
    metadata: {
      parts: [{ type: "text", text: "step 1\nstep 2" }],
    },
    createdAt: "2026-01-01T00:00:00Z",
  } as const;

  function renderObserver(status: string) {
    h.state.status = status;
    render(
      <MantineProvider>
        <ChatThread
          chatId="c1"
          initialRows={[]}
          onTurnFinished={vi.fn()}
          observedRow={observedRow as never}
        />
      </MantineProvider>,
    );
  }

  it("merges the polled run message when this tab is a passive observer", () => {
    renderObserver("ready");
    expect(h.state.setMessages).toHaveBeenCalledTimes(1);
    // The updater replaces/append the observed assistant row by id.
    const updater = h.state.setMessages.mock.calls[0][0] as (
      prev: { id: string; parts: { text: string }[] }[],
    ) => { id: string; parts: { text: string }[] }[];
    const merged = updater([{ id: "u1", parts: [{ text: "hi" }] }]);
    expect(merged).toHaveLength(2);
    expect(merged[1].id).toBe("a-run");
    expect(merged[1].parts[0].text).toBe("step 1\nstep 2");
  });

  it("does NOT merge while THIS tab is the streamer (no double-render)", () => {
    renderObserver("streaming");
    expect(h.state.setMessages).not.toHaveBeenCalled();
  });
});
