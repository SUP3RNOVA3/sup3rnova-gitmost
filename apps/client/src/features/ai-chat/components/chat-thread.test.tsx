import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
    resumeStream: vi.fn(),
    // The messages array useChat was seeded with (to assert strip/seed behavior).
    seededMessages: null as null | unknown[],
    transport: null as null | {
      prepareSendMessagesRequest?: (arg: {
        messages: unknown[];
        body: Record<string, unknown>;
      }) => { body: Record<string, unknown> };
      prepareReconnectToStreamRequest?: () => { api?: string };
      fetch?: (
        input: unknown,
        init?: { method?: string; body?: unknown },
      ) => Promise<unknown>;
    },
  },
}));

// Mock useChat: capture onFinish + seeded messages, return the spies and the
// controllable status.
vi.mock("@ai-sdk/react", () => ({
  useChat: (opts: {
    messages?: unknown[];
    onFinish?: (arg: Record<string, unknown>) => void;
  }) => {
    h.state.onFinish = opts.onFinish ?? null;
    h.state.seededMessages = opts.messages ?? null;
    return {
      messages: [],
      sendMessage: h.state.sendMessage,
      status: h.state.status,
      stop: h.state.stop,
      error: null,
      setMessages: h.state.setMessages,
      resumeStream: h.state.resumeStream,
    };
  },
}));

// Mock "ai": deterministic ids + a transport that records its options so the test
// can invoke prepareSendMessagesRequest / prepareReconnectToStreamRequest / fetch.
vi.mock("ai", () => {
  let counter = 0;
  return {
    generateId: () => `gid-${counter++}`,
    DefaultChatTransport: class {
      constructor(opts: Record<string, unknown>) {
        h.state.transport = opts as never;
      }
    },
  };
});

// Keep the ai-chat-query import light: ChatThread only needs the messages RQ key,
// so stub the module to avoid pulling axios / i18n transitively.
vi.mock("@/features/ai-chat/queries/ai-chat-query.ts", () => ({
  AI_CHAT_MESSAGES_RQ_KEY: (chatId: string) => ["ai-chat-messages", chatId],
}));

// Stub the heavy children: MessageList (markdown/render) and ChatInput (the
// composer). The ChatInput stub exposes a button that queues a message, the only
// interaction this test needs to populate the queue while "streaming".
vi.mock("@/features/ai-chat/components/message-list.tsx", () => ({
  default: () => <div data-testid="message-list" />,
}));
vi.mock("@/features/ai-chat/components/chat-input.tsx", () => ({
  default: ({
    onQueue,
    onStop,
  }: {
    onQueue: (text: string) => void;
    onStop: () => void;
  }) => (
    <>
      <button data-testid="queue-btn" onClick={() => onQueue("queued text")}>
        queue
      </button>
      <button aria-label="Stop" onClick={() => onStop()}>
        stop
      </button>
    </>
  ),
}));

import ChatThread from "./chat-thread";
import type { IAiChatMessageRow } from "@/features/ai-chat/types/ai-chat.types.ts";

function row(
  id: string,
  role: string,
  status?: string,
  text = "",
): IAiChatMessageRow {
  return { id, role, content: text, status, createdAt: "2026-01-01T00:00:00Z" };
}

function renderThread(props?: {
  chatId?: string | null;
  initialRows?: IAiChatMessageRow[];
  autonomousRunsEnabled?: boolean;
}) {
  const onTurnFinished = vi.fn();
  const onResumeFallback = vi.fn();
  const onServerStop = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ChatThread
          chatId={props?.chatId === undefined ? "c1" : props.chatId}
          initialRows={props?.initialRows ?? []}
          autonomousRunsEnabled={props?.autonomousRunsEnabled}
          onTurnFinished={onTurnFinished}
          onResumeFallback={onResumeFallback}
          onServerStop={onServerStop}
        />
      </MantineProvider>
    </QueryClientProvider>,
  );
  return { onTurnFinished, onResumeFallback, onServerStop, invalidateSpy, unmount };
}

function resetState() {
  h.state.status = "streaming";
  h.state.onFinish = null;
  h.state.seededMessages = null;
  h.state.transport = null;
  h.state.sendMessage.mockClear();
  h.state.stop.mockClear();
  h.state.setMessages.mockClear();
  h.state.resumeStream.mockClear();
}

describe("ChatThread — send now (#198)", () => {
  beforeEach(resetState);

  it("aborts the current turn and resends the queued message on the abort", () => {
    renderThread();

    fireEvent.click(screen.getByTestId("queue-btn"));
    const sendNowBtn = screen.getByLabelText("Send now");
    expect(sendNowBtn).toBeTruthy();

    fireEvent.click(sendNowBtn);
    expect(h.state.stop).toHaveBeenCalledTimes(1);
    expect(h.state.sendMessage).not.toHaveBeenCalled();

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

    const prep = h.state.transport!.prepareSendMessagesRequest!;
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(true);
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(false);
  });

  it("sends immediately without an interrupt when not streaming", () => {
    h.state.status = "ready";
    renderThread();

    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    expect(h.state.stop).not.toHaveBeenCalled();
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
    const prep = h.state.transport!.prepareSendMessagesRequest!;
    expect(prep({ messages: [], body: {} }).body.interrupted).toBe(false);
  });
});

// #396: in autonomous mode a live sendNow must additionally request the
// AUTHORITATIVE server stop of the detached run (a local abort is only a client
// disconnect the server ignores) and arm a bounded 409 retry so the re-POST
// converges once the one-active-run slot frees. Legacy mode is unchanged.
describe("ChatThread — send now server-stop + supersede retry (#396)", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  // A settled assistant tail => no mount resume (attemptResumeRef false), so the
  // "Send now" button is visible for the NEW local streaming turn while
  // autonomous runs are enabled.
  const settledTail = () => [
    row("u1", "user", undefined, "hi"),
    row("a1", "assistant", "succeeded", "done"),
  ];

  it("autonomous: sendNow during a live stream calls onServerStop with the chat id", () => {
    const { onServerStop } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: settledTail(),
    });
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    expect(h.state.stop).toHaveBeenCalledTimes(1);
    expect(onServerStop).toHaveBeenCalledWith("c1");
  });

  it("legacy (autonomous off): sendNow does NOT call onServerStop and does NOT retry the send", async () => {
    const { onServerStop } = renderThread({
      autonomousRunsEnabled: false,
      initialRows: settledTail(),
    });
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));
    expect(onServerStop).not.toHaveBeenCalled();

    // The supersede retry must NOT be armed: a POST that 409s is returned as-is
    // (single fetch, no retry).
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: "A_RUN_ALREADY_ACTIVE" }), {
          status: 409,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    let res!: Response;
    await act(async () => {
      res = (await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      })) as Response;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
  });

  it("armed supersede send retries 409 A_RUN_ALREADY_ACTIVE and succeeds once the slot frees", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    // Arm the retry by performing a live sendNow (autonomous branch sets the ref).
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    const fetchMock = vi
      .fn()
      // First POST: the old detached run still holds the slot -> 409.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "A_RUN_ALREADY_ACTIVE" }), {
          status: 409,
        }),
      )
      // Retry: the server stop settled the old run -> 200.
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    let res!: Response;
    await act(async () => {
      res = (await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      })) as Response;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("supersede retry is one-shot: a later send (ref cleared) does NOT retry a 409", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now")); // arms the one-shot

    // First armed send: immediately succeeds, consuming the arm.
    let fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A subsequent send is NOT armed -> a 409 is returned as-is (no retry).
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "A_RUN_ALREADY_ACTIVE" }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let res!: Response;
    await act(async () => {
      res = (await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      })) as Response;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
  });

  it("supersede retry is bounded: exhaustion surfaces the 409 error", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    // Every attempt 409s -> after 4 attempts the last 409 surfaces.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "A_RUN_ALREADY_ACTIVE" }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let res!: Response;
    await act(async () => {
      res = (await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      })) as Response;
    });
    // 4 attempts total (1 immediate + 3 backoff retries), then give up.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(res.status).toBe(409);
  });

  it("armed supersede send does NOT retry a non-409 status", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    let res!: Response;
    await act(async () => {
      res = (await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      })) as Response;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
  });

  // Strand-path regression: sendNow arms the supersede retry, but if the promoted
  // head is removed before the abort's onFinish lands, flushNext() sends nothing
  // (returns false) and NO re-POST consumes the arm. The arm must be disarmed on
  // that no-send branch so the NEXT unrelated NORMAL send does not inherit it and
  // silently retry a genuine 409 (e.g. a legitimate two-tab conflict) 4x instead
  // of surfacing it immediately.
  it("strand-path: a stranded supersede arm (flushNext no-send) does NOT retry a later normal 409", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    // Arm the retry via a live autonomous sendNow (promotes the head + arms).
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));

    // Remove the promoted head BEFORE the abort lands, so flushNext() returns
    // false (no POST) and the arm would strand without the disarm fix.
    fireEvent.click(screen.getByLabelText("Remove queued message"));

    // The abort's onFinish now takes the flushOnAbortRef branch, calls flushNext()
    // which finds an empty queue and returns false -> the no-send disarm must run.
    act(() => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [] },
        isAbort: true,
        isDisconnect: false,
        isError: false,
      });
    });
    // No re-POST was sent (nothing to flush).
    expect(h.state.sendMessage).not.toHaveBeenCalled();

    // A subsequent NORMAL send that 409s must be returned as-is (exactly 1 fetch):
    // the stranded arm must NOT cause the genuine 409 to be retried.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: "A_RUN_ALREADY_ACTIVE" }), {
          status: 409,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    let res!: Response;
    await act(async () => {
      res = (await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      })) as Response;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
  });

  it("armed supersede send does NOT retry a 409 with a different (non-A_RUN_ALREADY_ACTIVE) body", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "SOMETHING_ELSE" }), {
        status: 409,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    let res!: Response;
    await act(async () => {
      res = (await h.state.transport!.fetch!("http://x", {
        method: "POST",
        body: "{}",
      })) as Response;
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
  });
});

// #388: the editor selection is snapshotted at send time and nested inside
// openPage on the wire. The getter is read live from a ref, so each send ships a
// fresh snapshot.
describe("ChatThread — editor selection wiring (#388)", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  function renderWithSelection(props: {
    openPage?: { id: string; title: string } | null;
    getEditorSelection?: () => unknown;
  }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MantineProvider>
          <ChatThread
            chatId="c1"
            initialRows={[]}
            openPage={props.openPage as never}
            getEditorSelection={props.getEditorSelection as never}
            onTurnFinished={vi.fn()}
            onResumeFallback={vi.fn()}
            onServerStop={vi.fn()}
          />
        </MantineProvider>
      </QueryClientProvider>,
    );
  }

  it("nests the snapshot from the getter into openPage.selection at send time", () => {
    const selection = { text: "fix this", blockIds: ["b1"], before: "a " };
    renderWithSelection({
      openPage: { id: "p1", title: "Doc" },
      getEditorSelection: () => selection,
    });
    const prep = h.state.transport!.prepareSendMessagesRequest!;
    const openPage = prep({ messages: [], body: {} }).body.openPage as Record<
      string,
      unknown
    >;
    expect(openPage).toEqual({ id: "p1", title: "Doc", selection });
  });

  it("sends selection: null when the getter returns null", () => {
    renderWithSelection({
      openPage: { id: "p1", title: "Doc" },
      getEditorSelection: () => null,
    });
    const prep = h.state.transport!.prepareSendMessagesRequest!;
    const openPage = prep({ messages: [], body: {} }).body.openPage as Record<
      string,
      unknown
    >;
    expect(openPage).toEqual({ id: "p1", title: "Doc", selection: null });
  });

  it("does not send selection at all on a non-page route (openPage null)", () => {
    const getter = vi.fn(() => ({ text: "sel" }));
    renderWithSelection({ openPage: null, getEditorSelection: getter });
    const prep = h.state.transport!.prepareSendMessagesRequest!;
    expect(prep({ messages: [], body: {} }).body.openPage).toBeNull();
    // The getter must not even be consulted when there is no page.
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("ChatThread — turn-end decision (onFinish)", () => {
  beforeEach(resetState);

  function finishWith(flags: {
    isAbort?: boolean;
    isDisconnect?: boolean;
    isError?: boolean;
  }) {
    cleanup();
    h.state.sendMessage.mockClear();
    const { onTurnFinished } = renderThread();
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
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
    expect(screen.queryByText("Response stopped.")).toBeNull();
  });

  it("ENDS — keeps the queue intact on a user abort and shows the stopped notice", () => {
    finishWith({ isAbort: true });
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
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByText("Response stopped.")).toBeNull();
  });

  it("notifies the parent on EVERY terminal outcome", () => {
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

// #184 phase 1.5: the resumable-SSE client. A reopened tab resumes the live run
// via the SDK's reconnect transport (attach: replay + tail) instead of polling.
describe("ChatThread — resume (attach) machinery (#184)", () => {
  const streamingTail = () => [
    row("u1", "user", undefined, "hi"),
    row("a1", "assistant", "streaming", "partial"),
  ];
  const settledTail = () => [
    row("u1", "user", undefined, "hi"),
    row("a1", "assistant", "succeeded", "done"),
  ];
  const userTail = () => [row("u1", "user", undefined, "hi")];

  const visibleMsg = {
    id: "a1",
    role: "assistant",
    parts: [{ type: "text", text: "streamed answer" }],
  };
  const emptyMsg = { id: "a1", role: "assistant", parts: [] };

  beforeEach(resetState);
  // NOTE: do NOT vi.unstubAllGlobals() here — vitest.setup.ts installs
  // matchMedia/localStorage via vi.stubGlobal and unstubbing wipes them for the
  // rest of the file. Fetch is re-stubbed per test that needs it.
  afterEach(cleanup);

  it("resumes on mount only when the flag is on, chatId is set, and the tail is not a settled assistant", () => {
    // streaming tail -> resume
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);

    // user tail -> resume (the assistant row may not be seeded yet)
    cleanup();
    h.state.resumeStream.mockClear();
    renderThread({ autonomousRunsEnabled: true, initialRows: userTail() });
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);

    // settled assistant tail -> NO resume
    cleanup();
    h.state.resumeStream.mockClear();
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    expect(h.state.resumeStream).not.toHaveBeenCalled();

    // flag off -> NO resume
    cleanup();
    h.state.resumeStream.mockClear();
    renderThread({ autonomousRunsEnabled: false, initialRows: streamingTail() });
    expect(h.state.resumeStream).not.toHaveBeenCalled();

    // no chatId -> NO resume
    cleanup();
    h.state.resumeStream.mockClear();
    renderThread({
      autonomousRunsEnabled: true,
      chatId: null,
      initialRows: streamingTail(),
    });
    expect(h.state.resumeStream).not.toHaveBeenCalled();
  });

  it("strips the streaming tail from the seed, but keeps a user tail whole", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    // 2 rows in, streaming tail stripped -> 1 seeded message.
    expect(h.state.seededMessages).toHaveLength(1);

    cleanup();
    renderThread({ autonomousRunsEnabled: true, initialRows: userTail() });
    // user tail is not stripped.
    expect(h.state.seededMessages).toHaveLength(1);
  });

  it("builds the attach URL with expect=live&anchor only when the streaming tail was stripped", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    expect(h.state.transport!.prepareReconnectToStreamRequest!().api).toBe(
      "/api/ai-chat/runs/c1/stream?expect=live&anchor=a1",
    );

    cleanup();
    renderThread({ autonomousRunsEnabled: true, initialRows: userTail() });
    expect(h.state.transport!.prepareReconnectToStreamRequest!().api).toBe(
      "/api/ai-chat/runs/c1/stream",
    );
  });

  async function fetch204() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 204, ok: false }),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "GET" });
    });
  }

  it("204 on a user tail: no crash, no restore, reconcile+invalidate, onResumeFallback(true)", async () => {
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: userTail(),
    });
    await fetch204();
    // No stripped row -> no restore merge.
    expect(h.state.setMessages).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
  });

  it("204 on a streaming tail: restore + invalidate + onResumeFallback(true)", async () => {
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    await fetch204();
    // Stripped row is restored to the store.
    expect(h.state.setMessages).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
  });

  it("F7 restart-survival: a 500 attach failure restores the stripped row AND arms the poll (not lost)", async () => {
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 500, ok: false }),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "GET" });
    });
    expect(h.state.setMessages).toHaveBeenCalledTimes(1); // stripped row restored
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true); // degraded poll armed
  });

  it("F7 restart-survival: a network throw restores the stripped row AND arms the poll", async () => {
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    await act(async () => {
      await h.state
        .transport!.fetch!("http://x", { method: "GET" })
        .catch(() => undefined); // the wrapper rethrows; swallow here
    });
    expect(h.state.setMessages).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
  });

  it("unmount during a pending attach aborts the controller and gates late callbacks", async () => {
    const { onResumeFallback, invalidateSpy, unmount } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    let abortSeen = false;
    let resolveFetch!: (v: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_input: unknown, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => {
          abortSeen = true;
        });
        return new Promise((res) => {
          resolveFetch = res;
        });
      }),
    );
    // Kick a reconnect GET (stays pending).
    let pending!: Promise<unknown>;
    act(() => {
      pending = h.state.transport!.fetch!("http://x", { method: "GET" });
    });
    // Unmount: the cleanup aborts the in-flight attach.
    unmount();
    expect(abortSeen).toBe(true);
    // A late 204 landing after unmount must NOT arm a poll / invalidate the (now
    // different) chat.
    onResumeFallback.mockClear();
    invalidateSpy.mockClear();
    await act(async () => {
      resolveFetch({ status: 204, ok: false });
      await pending;
    });
    expect(onResumeFallback).not.toHaveBeenCalledWith(true);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a resume fetch error clears resumedTurn so the next local turn flushes the queue", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    h.state.status = "ready";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 500, ok: false }),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "GET" });
    });
    // Queue then clean-finish: suppression was cleared, so the queue flushes.
    fireEvent.click(screen.getByTestId("queue-btn"));
    act(() => {
      h.state.onFinish?.({
        message: visibleMsg,
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
  });

  it("a resumed turn's onFinish does NOT flush the queue", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    act(() => {
      h.state.onFinish?.({
        message: visibleMsg,
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.sendMessage).not.toHaveBeenCalled();
  });

  it("a healthy resumed finish (visible content) arms nothing and keeps the store", () => {
    h.state.status = "ready";
    const { onResumeFallback } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    h.state.setMessages.mockClear();
    onResumeFallback.mockClear();
    act(() => {
      h.state.onFinish?.({
        message: visibleMsg,
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    // No restore (would clobber the fuller streamed message), no poll arm.
    expect(h.state.setMessages).not.toHaveBeenCalled();
    expect(onResumeFallback).not.toHaveBeenCalledWith(true);
  });

  it("isDisconnect WITH visible content arms the poll but does NOT restore", () => {
    h.state.status = "ready";
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    h.state.setMessages.mockClear();
    onResumeFallback.mockClear();
    invalidateSpy.mockClear();
    act(() => {
      h.state.onFinish?.({
        message: visibleMsg,
        isAbort: false,
        isDisconnect: true,
        isError: false,
      });
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    // Restore forbidden: the on-screen partial must not roll back.
    expect(h.state.setMessages).not.toHaveBeenCalled();
  });

  it("an empty resumed message (starved replay) restores the stripped row AND arms the poll", () => {
    h.state.status = "ready";
    const { onResumeFallback } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    h.state.setMessages.mockClear();
    onResumeFallback.mockClear();
    act(() => {
      h.state.onFinish?.({
        message: emptyMsg,
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.setMessages).toHaveBeenCalledTimes(1); // restore
    expect(onResumeFallback).toHaveBeenCalledWith(true); // arm
  });

  it("degraded-merge: merges the tail per initialRows update, and settles disarm the poll", async () => {
    h.state.status = "ready";
    const { rerender, onResumeFallback } = renderResumable(streamingTail());
    // Arm reconcile via a 204.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 204, ok: false }),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "GET" });
    });
    h.state.setMessages.mockClear();
    onResumeFallback.mockClear();

    // A streaming-tail update: merge, poll stays armed.
    rerender([
      row("u1", "user", undefined, "hi"),
      row("a1", "assistant", "streaming", "step 1\nstep 2"),
    ]);
    expect(h.state.setMessages).toHaveBeenCalledTimes(1);
    expect(onResumeFallback).not.toHaveBeenCalledWith(false);

    // A settled-tail update: merge + disarm.
    h.state.setMessages.mockClear();
    rerender([
      row("u1", "user", undefined, "hi"),
      row("a1", "assistant", "succeeded", "final"),
    ]);
    expect(h.state.setMessages).toHaveBeenCalledTimes(1);
    expect(onResumeFallback).toHaveBeenCalledWith(false);
  });

  it("a local stream disarms both the merge and the poll", () => {
    h.state.status = "streaming";
    const { rerender, onResumeFallback } = renderResumable(streamingTail());
    onResumeFallback.mockClear();
    // A re-render while streaming: the reconciliation effect disarms.
    rerender(streamingTail());
    expect(onResumeFallback).toHaveBeenCalledWith(false);
  });

  it("Send now is hidden on a resumed turn but visible on a local stream", () => {
    // Resumed turn: hidden.
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    expect(screen.queryByLabelText("Send now")).toBeNull();

    // Local streaming turn (no resume): visible.
    cleanup();
    resetState();
    renderThread({ initialRows: [] });
    fireEvent.click(screen.getByTestId("queue-btn"));
    expect(screen.getByLabelText("Send now")).toBeTruthy();
  });

  it("handleStop aborts the attach controller and calls onServerStop", async () => {
    const { onServerStop } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    // Establish an attach controller via a (pending) reconnect GET.
    let abortSeen = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_input: unknown, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => {
          abortSeen = true;
        });
        return new Promise(() => undefined); // never resolves
      }),
    );
    act(() => {
      void h.state.transport!.fetch!("http://x", { method: "GET" });
    });
    fireEvent.click(screen.getByLabelText("Stop"));
    expect(abortSeen).toBe(true);
    expect(onServerStop).toHaveBeenCalledWith("c1");
  });
});

// Helper: render a resumable thread and expose a rerender that only swaps
// initialRows (the degraded-merge effect depends on it).
function renderResumable(initialRows: IAiChatMessageRow[]) {
  const onResumeFallback = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Wrapper = ({ rows }: { rows: IAiChatMessageRow[] }) => (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>
        <ChatThread
          chatId="c1"
          initialRows={rows}
          autonomousRunsEnabled
          onTurnFinished={vi.fn()}
          onResumeFallback={onResumeFallback}
        />
      </MantineProvider>
    </QueryClientProvider>
  );
  const view = render(<Wrapper rows={initialRows} />);
  const rerender = (rows: IAiChatMessageRow[]) =>
    act(() => view.rerender(<Wrapper rows={rows} />));
  return { rerender, onResumeFallback };
}

// #430: auto-reconnect to a DETACHED run after a LIVE SSE disconnect. The mount
// path only resumes on mount/reload; these cover the missing trigger — a live
// `isDisconnect` on onFinish must (backoff-)re-attach WITHOUT a reload, pin+strip
// the live row to avoid duplicates, fall back to the degraded poll on a 204, and
// exhaust to a manual Retry.
describe("ChatThread — live reconnect after isDisconnect (#430)", () => {
  // A LIVE local turn that just dropped: the settled tail existed before, and the
  // partial assistant row lives only in `messages` (not persisted as a tail).
  const settledTail = () => [
    row("u1", "user", undefined, "hi"),
    row("a1", "assistant", "succeeded", "done"),
  ];
  // The partial assistant message onFinish hands us for the dropped LIVE turn.
  const liveMsg = {
    id: "a2",
    role: "assistant",
    parts: [{ type: "text", text: "partial live answer" }],
  };

  beforeEach(() => {
    resetState();
    // status "ready": with a live disconnect the mock is not streaming, so the
    // status==="streaming" auto-clear effect stays out of the way.
    h.state.status = "ready";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  // Render a NON-resuming mount (settled tail -> no mount resume) with autonomous
  // runs on, then simulate a live disconnect via onFinish.
  function renderLiveThenDisconnect() {
    const view = renderThread({
      autonomousRunsEnabled: true,
      initialRows: settledTail(),
    });
    // The settled tail must NOT have triggered a mount resume.
    expect(h.state.resumeStream).not.toHaveBeenCalled();
    act(() => {
      h.state.onFinish?.({
        message: liveMsg,
        isAbort: false,
        isDisconnect: true,
        isError: false,
      });
    });
    return view;
  }

  // Fire the pending (scheduled) attempt for `attempt` (backoff = 1s,2s,4s,...).
  function advanceToAttempt(attempt: number) {
    act(() => {
      vi.advanceTimersByTime(1000 * 2 ** (attempt - 1));
    });
  }

  // Simulate the reconnect GET returning 204 (nothing live) so the transport's
  // no-active-stream recovery runs.
  async function reconnect204() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 204, ok: false }),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "GET" });
    });
  }

  // Simulate the reconnect GET returning a live 2xx stream.
  async function reconnect200() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, ok: true }),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "GET" });
    });
  }

  it("calls resumeStream POST-mount (a live disconnect triggers a backoff reconnect)", () => {
    renderLiveThenDisconnect();
    // The banner shows immediately; the attach itself fires after the first backoff.
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
    expect(h.state.resumeStream).not.toHaveBeenCalled();
    advanceToAttempt(1);
    // resumeStream is now called AFTER mount — the bug was it only ever fired once
    // on mount. The reconnect URL pins expect=live&anchor to OUR run.
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
    expect(h.state.transport!.prepareReconnectToStreamRequest!().api).toBe(
      "/api/ai-chat/runs/c1/stream?expect=live&anchor=a2",
    );
  });

  it("strips the pinned live row before replay so content is NOT duplicated", () => {
    renderLiveThenDisconnect();
    advanceToAttempt(1);
    // The attempt strips the anchor row from the store (the live replay rebuilds
    // it). Apply the setMessages updater to prove it removes exactly the anchor.
    const updater = h.state.setMessages.mock.calls.at(-1)![0] as (
      prev: { id: string }[],
    ) => { id: string }[];
    expect(updater([{ id: "u1" }, { id: "a2" }])).toEqual([{ id: "u1" }]);
  });

  it("a live re-attach (2xx) clears the reconnect banner", async () => {
    renderLiveThenDisconnect();
    advanceToAttempt(1);
    await reconnect200();
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
  });

  it("a 204 arms the degraded poll and backs off to the next attempt", async () => {
    const { onResumeFallback } = renderLiveThenDisconnect();
    advanceToAttempt(1);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
    await reconnect204();
    // Fallback engaged: the degraded poll is armed (204 -> onNoActiveStream).
    expect(onResumeFallback).toHaveBeenCalledWith(true);
    // Still reconnecting — the banner advanced to attempt 2/5.
    expect(screen.getByText(/reconnecting.*2\/5/i)).toBeTruthy();
    // The next backoff fires attempt 2 (another resumeStream).
    advanceToAttempt(2);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(2);
  });

  it("exhausts the attempt limit into a manual Retry, which restarts the sequence", async () => {
    renderLiveThenDisconnect();
    // Drive all 5 attempts, each failing with a 204.
    for (let n = 1; n <= 5; n++) {
      advanceToAttempt(n);
      expect(h.state.resumeStream).toHaveBeenCalledTimes(n);
      await reconnect204();
    }
    // The 5th 204 exhausted the cap -> the manual Retry replaces the banner.
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
    const retry = screen.getByText("Retry");
    expect(retry).toBeTruthy();
    // Retry fires attempt 1 immediately (no backoff) — a 6th resumeStream.
    act(() => {
      fireEvent.click(retry);
    });
    expect(h.state.resumeStream).toHaveBeenCalledTimes(6);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });

  it("does NOT reconnect when autonomous runs are disabled", () => {
    renderThread({ autonomousRunsEnabled: false, initialRows: settledTail() });
    act(() => {
      h.state.onFinish?.({
        message: liveMsg,
        isAbort: false,
        isDisconnect: true,
        isError: false,
      });
    });
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
    // The terminal "connection lost" notice is shown instead (unchanged behavior).
    expect(
      screen.getByText("Connection lost — the answer was interrupted."),
    ).toBeTruthy();
    advanceToAttempt(1);
    expect(h.state.resumeStream).not.toHaveBeenCalled();
  });
});
