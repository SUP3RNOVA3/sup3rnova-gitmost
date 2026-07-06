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
      fetch?: (input: unknown, init?: { method?: string }) => Promise<unknown>;
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
