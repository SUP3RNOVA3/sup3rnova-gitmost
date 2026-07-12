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
    messages: [] as unknown[],
    // Mirrors the SDK: on an isError finish (incl. a network drop, which is ALWAYS
    // isError+isDisconnect) the SDK ALSO sets useChat `error`. Realistic tests set
    // this so the banner-priority (errorView vs recovery phase) is actually exercised.
    error: null as null | { message: string },
    onFinish: null as null | ((arg: Record<string, unknown>) => void),
    sendMessage: vi.fn(),
    stop: vi.fn(),
    setMessages: vi.fn(),
    resumeStream: vi.fn(),
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
    // getRun mock (POST /ai-chat/run run-fact). Default: no active run.
    getRun: vi.fn(
      async (_chatId?: string) =>
        ({ run: null, message: null }) as {
          run: { id: string; status: string } | null;
          message: unknown;
        },
    ),
  },
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (opts: {
    messages?: unknown[];
    onFinish?: (arg: Record<string, unknown>) => void;
  }) => {
    h.state.onFinish = opts.onFinish ?? null;
    h.state.seededMessages = opts.messages ?? null;
    return {
      messages: h.state.messages,
      sendMessage: h.state.sendMessage,
      status: h.state.status,
      stop: h.state.stop,
      error: h.state.error,
      setMessages: h.state.setMessages,
      resumeStream: h.state.resumeStream,
    };
  },
}));

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

vi.mock("@/features/ai-chat/queries/ai-chat-query.ts", () => ({
  AI_CHAT_MESSAGES_RQ_KEY: (chatId: string) => ["ai-chat-messages", chatId],
}));

// The run-fact service (POST /ai-chat/run). Mocked so a user-tail mount and the
// supersede verify do not hit axios.
vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  getRun: (chatId: string) => h.state.getRun(chatId),
}));

vi.mock("@/features/ai-chat/components/message-list.tsx", () => ({
  default: () => <div data-testid="message-list" />,
}));
vi.mock("@/features/ai-chat/components/chat-input.tsx", () => ({
  default: ({
    onQueue,
    onStop,
    onSend,
  }: {
    onQueue: (text: string) => void;
    onStop: () => void;
    onSend: (text: string) => void;
  }) => (
    <>
      <button data-testid="queue-btn" onClick={() => onQueue("queued text")}>
        queue
      </button>
      <button data-testid="send-btn" onClick={() => onSend("typed text")}>
        send
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
  h.state.messages = [];
  h.state.error = null;
  h.state.onFinish = null;
  h.state.seededMessages = null;
  h.state.transport = null;
  h.state.sendMessage.mockClear();
  h.state.stop.mockClear();
  h.state.setMessages.mockClear();
  h.state.resumeStream.mockClear();
  h.state.getRun.mockReset();
  h.state.getRun.mockResolvedValue({ run: null, message: null });
}

const streamingTail = () => [
  row("u1", "user", undefined, "hi"),
  row("a1", "assistant", "streaming", "partial"),
];
const settledTail = () => [
  row("u1", "user", undefined, "hi"),
  row("a1", "assistant", "succeeded", "done"),
];
const userTail = () => [row("u1", "user", undefined, "hi")];

// -----------------------------------------------------------------------------
// Send now (#198) — local send + #488 commit 5 CAS supersede.
// -----------------------------------------------------------------------------
describe("ChatThread — send now", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  it("sends immediately (no interrupt) when not streaming", () => {
    h.state.status = "ready";
    renderThread({ initialRows: settledTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));
    expect(h.state.stop).not.toHaveBeenCalled();
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
  });

  // Drive a REAL live LOCAL stream with an active run-fact: a runId-bearing
  // assistant message (mount adoption -> RUN_FACT) + a local send (SEND_LOCAL ->
  // FSM `sending`, ownership local). sendNow reads LIVENESS off the FSM phase
  // (LOW-1), so a faked SDK status alone is not enough — the stream must be real.
  function startLocalStreamWithRun() {
    h.state.status = "streaming";
    h.state.messages = [
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "x" }],
        metadata: { runId: "run-1" },
      },
    ];
    const view = renderThread({
      autonomousRunsEnabled: true,
      initialRows: settledTail(),
    });
    fireEvent.click(screen.getByTestId("send-btn")); // SEND_LOCAL -> FSM `sending`
    h.state.sendMessage.mockClear();
    return view;
  }

  it("#488 commit 5 / F1: sendNow ABORTS stream A first, then sends B (CAS) only after A finalizes", async () => {
    startLocalStreamWithRun();
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));
    // F1: A is ABORTED, and B is NOT sent yet (no overlap).
    expect(h.state.stop).toHaveBeenCalledTimes(1);
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    // A's onFinish fires -> B is scheduled on a microtask (after A finalizes).
    await act(async () => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [] },
        isAbort: true,
        isDisconnect: false,
        isError: false,
      });
      await Promise.resolve();
    });
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
    // B's POST carries supersede:{runId} (read-and-cleared once).
    const prep = h.state.transport!.prepareSendMessagesRequest!;
    expect(prep({ messages: [], body: {} }).body.supersede).toEqual({
      runId: "run-1",
    });
    expect(prep({ messages: [], body: {} }).body.supersede).toBeUndefined();
  });

  it("#488 F1: a superseded stream's LATE disconnect does NOT falsely reconnect (epoch stamp drops it)", async () => {
    // MUTATION-VERIFY: drop `epoch: stampEpoch` from the supersede-branch
    // FINISH_DISCONNECT dispatch and this goes red (A's disconnect -> reconnecting).
    startLocalStreamWithRun();
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now")); // -> superseding, aborts A
    // A ends via a REAL network drop { isError:true, isDisconnect:true } + error set
    // (the server CAS closed it). The OLD overlap bug would route the LIVE new run
    // into a false reconnect banner.
    h.state.error = { message: "Failed to fetch" };
    await act(async () => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "x" }] },
        isAbort: false,
        isDisconnect: true,
        isError: true,
      });
      await Promise.resolve();
    });
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
    // ...and B was still sent.
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
  });

  it("#488 commit 5: a supersede POST that 409s SUPERSEDE_TIMEOUT is returned as-is (NO retry ladder)", async () => {
    startLocalStreamWithRun();
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now")); // -> superseding, arms body
    // Consume the supersede body (as the SDK would) so the POST is the CAS one.
    h.state.transport!.prepareSendMessagesRequest!({ messages: [], body: {} });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "SUPERSEDE_TIMEOUT" }), {
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
    // Exactly ONE fetch (the old bounded 409 retry ladder is gone).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
  });

  it("#488 LOW-1: sendNow when A has ALREADY settled (statusRef stale) sends immediately, not stuck superseding", () => {
    startLocalStreamWithRun(); // FSM `sending`, mock status "streaming"
    // A settles cleanly -> FSM `idle`. The mock status stays "streaming" (render-
    // lagged), which the OLD statusRef gate would misread as "still live".
    act(() => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    h.state.sendMessage.mockClear();
    h.state.stop.mockClear();
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now"));
    // The FSM phase (idle) is authoritative -> B is sent IMMEDIATELY, not routed
    // into an aborting supersede that would strand the machine (A's second onFinish
    // never comes) and lose the message.
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
    expect(h.state.stop).not.toHaveBeenCalled();
  });

  it("#488 LOW-2: a second Send now while a supersede is in flight is a no-op (first message not lost)", () => {
    startLocalStreamWithRun();
    fireEvent.click(screen.getByTestId("queue-btn")); // X
    fireEvent.click(screen.getByTestId("queue-btn")); // Y
    expect(screen.getAllByLabelText("Send now")).toHaveLength(2);
    fireEvent.click(screen.getAllByLabelText("Send now")[0]); // supersede X -> superseding
    expect(h.state.stop).toHaveBeenCalledTimes(1);
    // Y is still queued; a second Send now must NOT clobber X or re-abort.
    const remaining = screen.getAllByLabelText("Send now");
    expect(remaining).toHaveLength(1);
    fireEvent.click(remaining[0]);
    expect(h.state.stop).toHaveBeenCalledTimes(1); // no second abort
    // Y is still queued (kept, not lost, not sent).
    expect(screen.getAllByLabelText("Remove queued message")).toHaveLength(1);
  });

  it("Stop then a REAL network-drop finish exits to idle (honor-in-stopping), NOT a false reconnect", () => {
    // Regression for the disconnect-first reorder: on the STOP path, even a drop-
    // form finish { isError:true, isDisconnect:true } arriving in `stopping` must be
    // HONORED (reducer) and exit to idle — it must NOT enter the reconnect ladder.
    startLocalStreamWithRun(); // live local stream, autonomous
    fireEvent.click(screen.getByLabelText("Stop")); // STOP_REQUESTED -> stopping
    h.state.error = { message: "Failed to fetch" };
    act(() => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [] },
        isAbort: false,
        isDisconnect: true,
        isError: true,
      });
    });
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
  });

  it("#488 review-2: an observer turn's clean finish re-exposes 'Send now' (ownership reset to local)", () => {
    // Mount attach -> observer. The queued message shows only "Remove" while
    // observing; once the attached run finishes CLEAN the FSM resets ownership to
    // local, so "Send now" becomes available again (composer is free).
    // MUTATION-VERIFY: drop `ownership:"local"` from FINISH_CLEAN -> stays observer
    // -> "Send now" stays hidden -> red.
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    expect(screen.queryByLabelText("Send now")).toBeNull(); // observer -> hidden
    act(() => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(screen.getByLabelText("Send now")).toBeTruthy(); // ownership local again
  });

  it("#488 review-3: a successful CAS supersede POST (200) exits `superseding` (Send now works again)", async () => {
    // Happy-path of the transport 409/CAS block: SUPERSEDE_READY was never executed
    // in tests (reviewer confirmed no-op mutation stayed green). If it does not fire,
    // the machine stays `superseding` for the whole B stream and "Send now" is dead.
    startLocalStreamWithRun();
    fireEvent.click(screen.getByTestId("queue-btn")); // X
    fireEvent.click(screen.getByLabelText("Send now")); // -> superseding, stop() #1
    expect(h.state.stop).toHaveBeenCalledTimes(1);
    // A's onFinish sends B (clears the pending-supersede text) — the realistic
    // no-overlap sequence.
    await act(async () => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [] },
        isAbort: true,
        isDisconnect: false,
        isError: false,
      });
      await Promise.resolve();
    });
    // B's CAS POST returns 200 -> SUPERSEDE_READY -> streaming.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "POST", body: "{}" });
    });
    // We LEFT `superseding`: a fresh Send now supersedes AGAIN (still stuck in
    // superseding -> LOW-2 guard would no-op it). MUTATION-VERIFY: no-op
    // SUPERSEDE_READY -> stuck superseding -> stop stays at 1 -> red.
    fireEvent.click(screen.getByTestId("queue-btn")); // Y
    fireEvent.click(screen.getByLabelText("Send now"));
    expect(h.state.stop).toHaveBeenCalledTimes(2);
  });

  it("#488 review-3 sibling: a 409 SUPERSEDE_TARGET_MISMATCH fires the /run verify", async () => {
    startLocalStreamWithRun();
    fireEvent.click(screen.getByTestId("queue-btn"));
    fireEvent.click(screen.getByLabelText("Send now")); // -> superseding
    h.state.getRun.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          // REAL server body shape: the current run id is `activeRunId`, NOT `runId`
          // (see ai-chat.controller.ts SUPERSEDE_TARGET_MISMATCH branch).
          JSON.stringify({ code: "SUPERSEDE_TARGET_MISMATCH", activeRunId: "run-x" }),
          { status: 409 },
        ),
      ),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "POST", body: "{}" });
    });
    // SUPERSEDE_MISMATCH -> error(supersede-mismatch) + postRun(verify) -> getRun.
    expect(h.state.getRun).toHaveBeenCalledWith("c1");
  });

  it("#497/W1: the mismatch ABSORBS the server's activeRunId into runFact (fast hint is live) — a follow-up Send now CAS-targets it", async () => {
    // The 409 body's current run id is `activeRunId`; read409 must feed THAT into
    // SUPERSEDE_MISMATCH{currentRunId} -> runFact, else the fast hint is undefined.
    // Observe the absorbed fact via the NEXT CAS supersede body. Keep the verify
    // getRun PENDING so it cannot overwrite the absorbed fact with its own result.
    h.state.getRun.mockReturnValue(new Promise(() => {})); // verify never resolves
    startLocalStreamWithRun(); // runFact run-1, sending, local, autonomous
    fireEvent.click(screen.getByTestId("queue-btn")); // X
    fireEvent.click(screen.getByLabelText("Send now")); // -> superseding (target run-1)
    // A's onFinish sends B and CLEARS the pending-supersede text (no-overlap).
    await act(async () => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [] },
        isAbort: true,
        isDisconnect: false,
        isError: false,
      });
      await Promise.resolve();
    });
    // B's CAS POST -> 409 SUPERSEDE_TARGET_MISMATCH with the REAL field `activeRunId`.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: "SUPERSEDE_TARGET_MISMATCH", activeRunId: "run-x" }),
          { status: 409 },
        ),
      ),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "POST", body: "{}" });
    });
    // runFact is now the absorbed "run-x". SEND_LOCAL preserves it; a fresh Send now
    // then CAS-supersedes THAT run — surfacing runFact through the supersede body.
    fireEvent.click(screen.getByTestId("send-btn")); // SEND_LOCAL -> sending, local
    fireEvent.click(screen.getByTestId("queue-btn")); // Y
    fireEvent.click(screen.getByLabelText("Send now")); // CAS -> arms pendingSupersede
    const { body } = h.state.transport!.prepareSendMessagesRequest!({
      messages: [],
      body: {},
    });
    // MUTATION-VERIFY: revert read409 to `runId` -> currentRunId undefined -> runFact
    // stays "run-1" -> the CAS targets "run-1" -> this assertion reddens.
    expect((body.supersede as { runId?: string } | undefined)?.runId).toBe("run-x");
  });

  it("#497/S4: a plain 409 A_RUN_ALREADY_ACTIVE absorbs activeRunId into runFact so Send now CAS-targets the foreign run", async () => {
    startLocalStreamWithRun(); // sending, local, autonomous, runFact run-1
    // A plain (non-supersede) POST hits the one-active-run gate. The FSM must adopt
    // the server's activeRunId as the run-fact — NOT stay blind.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ code: "A_RUN_ALREADY_ACTIVE", activeRunId: "run-foreign" }),
          { status: 409 },
        ),
      ),
    );
    // Drive a NON-supersede POST (phase is `sending`, not `superseding`).
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "POST", body: "{}" });
    });
    // runFact is now "run-foreign". SEND_LOCAL preserves it; Send now CAS-targets it.
    fireEvent.click(screen.getByTestId("send-btn")); // SEND_LOCAL -> sending, local
    fireEvent.click(screen.getByTestId("queue-btn")); // Y
    fireEvent.click(screen.getByLabelText("Send now")); // CAS -> arms pendingSupersede
    const { body } = h.state.transport!.prepareSendMessagesRequest!({
      messages: [],
      body: {},
    });
    // MUTATION-VERIFY: drop the activeRunId threading (or read the wrong field) ->
    // runFact stays "run-1" -> the CAS targets "run-1" -> this assertion reddens.
    expect((body.supersede as { runId?: string } | undefined)?.runId).toBe(
      "run-foreign",
    );
  });

  it("#488 review-3 sibling: a plain 409 A_RUN_ALREADY_ACTIVE shows the classified banner", async () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    // The SDK sets useChat error to the 409 body on the failed POST.
    h.state.error = {
      message:
        '{"message":"active","code":"A_RUN_ALREADY_ACTIVE","statusCode":409}',
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "A_RUN_ALREADY_ACTIVE" }), {
          status: 409,
        }),
      ),
    );
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "POST", body: "{}" });
    });
    // RUN_ALREADY_ACTIVE -> phase error(kind) -> the phase-gate lets errorView show
    // the classified banner.
    expect(screen.getByText("The agent is already answering")).toBeTruthy();
  });

  it("Send now is HIDDEN while observing a resumed run and VISIBLE on a local stream", () => {
    // Resumed (mount attach) -> observer -> hidden.
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    expect(screen.queryByLabelText("Send now")).toBeNull();
    // Local stream (no resume) -> visible.
    cleanup();
    resetState();
    renderThread({ initialRows: [] });
    fireEvent.click(screen.getByTestId("queue-btn"));
    expect(screen.getByLabelText("Send now")).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// onFinish flush gated on mount (#486).
// -----------------------------------------------------------------------------
describe("ChatThread — onFinish flush gated on mount (#486)", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  it("a clean onFinish WHILE MOUNTED flushes the queued message", () => {
    renderThread();
    fireEvent.click(screen.getByTestId("queue-btn"));
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    act(() => {
      h.state.onFinish?.({
        message: { id: "a", role: "assistant", parts: [] },
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "queued text" });
  });

  it("a clean onFinish AFTER unmount does NOT flush (no ghost send)", () => {
    const { unmount } = renderThread();
    fireEvent.click(screen.getByTestId("queue-btn"));
    h.state.sendMessage.mockClear();
    unmount();
    act(() => {
      h.state.onFinish?.({
        message: { id: "a", role: "assistant", parts: [] },
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.sendMessage).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Turn-end decision (onFinish).
// -----------------------------------------------------------------------------
describe("ChatThread — turn-end decision (onFinish)", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  function finishWith(flags: {
    isAbort?: boolean;
    isDisconnect?: boolean;
    isError?: boolean;
  }) {
    const { onTurnFinished } = renderThread();
    fireEvent.click(screen.getByTestId("queue-btn"));
    // Mirror the SDK: any isError finish (a provider error or a drop) also sets
    // useChat `error` (a drop message triggers the connection-lost classification).
    if (flags.isError)
      h.state.error = { message: flags.isDisconnect ? "Failed to fetch" : "500: boom" };
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

  it("ENDS — keeps the queue on a user abort and shows the stopped notice", () => {
    finishWith({ isAbort: true });
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Response stopped.")).toBeTruthy();
  });

  it("ENDS — keeps the queue on a REAL disconnect (non-autonomous) and shows the notice", () => {
    // Real SDK drop form: { isError:true, isDisconnect:true }. With the buggy
    // isError-first order this would fall to the terminal error branch (no notice).
    finishWith({ isDisconnect: true, isError: true });
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    expect(
      screen.getByText("Connection lost — the answer was interrupted."),
    ).toBeTruthy();
  });

  it("ENDS — keeps the queue on a NON-disconnect stream error (no notice)", () => {
    // A provider error is { isError:true, isDisconnect:false } — terminal.
    finishWith({ isError: true });
    expect(h.state.sendMessage).not.toHaveBeenCalled();
    expect(screen.queryByText("Response stopped.")).toBeNull();
  });

  it("notifies the parent on EVERY terminal outcome", () => {
    for (const flags of [
      {},
      { isAbort: true },
      { isDisconnect: true, isError: true },
      { isError: true },
    ]) {
      cleanup();
      resetState();
      const { onTurnFinished } = finishWith(flags);
      expect(onTurnFinished).toHaveBeenCalled();
    }
  });
});

// -----------------------------------------------------------------------------
// editor selection wiring (#388).
// -----------------------------------------------------------------------------
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

  it("nests the snapshot into openPage.selection at send time", () => {
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

  it("does not consult the getter on a non-page route (openPage null)", () => {
    const getter = vi.fn(() => ({ text: "sel" }));
    renderWithSelection({ openPage: null, getEditorSelection: getter });
    const prep = h.state.transport!.prepareSendMessagesRequest!;
    expect(prep({ messages: [], body: {} }).body.openPage).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Resume (attach) machinery (#184) + #488 commit 4b run-fact gating.
// -----------------------------------------------------------------------------
describe("ChatThread — resume (attach) machinery", () => {
  beforeEach(resetState);
  afterEach(cleanup);

  it("resumes on mount for a STREAMING tail (the streaming status is the run-fact)", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
  });

  it("does NOT resume for a settled tail, flag off, or no chatId", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: settledTail() });
    expect(h.state.resumeStream).not.toHaveBeenCalled();
    cleanup();
    resetState();
    renderThread({ autonomousRunsEnabled: false, initialRows: streamingTail() });
    expect(h.state.resumeStream).not.toHaveBeenCalled();
    cleanup();
    resetState();
    renderThread({
      autonomousRunsEnabled: true,
      chatId: null,
      initialRows: streamingTail(),
    });
    expect(h.state.resumeStream).not.toHaveBeenCalled();
  });

  it("#488 commit 4b: a USER tail resumes ONLY when POST /run confirms an active run", async () => {
    h.state.getRun.mockResolvedValue({
      run: { id: "run-1", status: "running" },
      message: null,
    });
    renderThread({ autonomousRunsEnabled: true, initialRows: userTail() });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.state.getRun).toHaveBeenCalledWith("c1");
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
  });

  it("#488 commit 4b: a USER tail with NO active run does NOT resume and does NOT arm the poll", async () => {
    h.state.getRun.mockResolvedValue({ run: null, message: null });
    const { onResumeFallback } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: userTail(),
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.state.resumeStream).not.toHaveBeenCalled();
    expect(onResumeFallback).not.toHaveBeenCalledWith(true);
  });

  it("#488 F2: a local send DURING the mount getRun round-trip is NOT hijacked by the late attach", async () => {
    // getRun stays pending while the user sends locally; its late resolve would
    // otherwise ATTACH_START and flip the local turn into an observer-attach.
    let resolveGetRun!: (v: {
      run: { id: string; status: string } | null;
      message: unknown;
    }) => void;
    h.state.getRun.mockReturnValue(
      new Promise((r) => {
        resolveGetRun = r;
      }),
    );
    renderThread({ autonomousRunsEnabled: true, initialRows: userTail() });
    // Local send in flight of getRun -> SEND_LOCAL (phase sending, ownership local).
    fireEvent.click(screen.getByTestId("send-btn"));
    expect(h.state.sendMessage).toHaveBeenCalledWith({ text: "typed text" });
    // getRun resolves with an ACTIVE run -> the F2 guard ignores ATTACH_START.
    await act(async () => {
      resolveGetRun({ run: { id: "run-1", status: "running" }, message: null });
      await Promise.resolve();
    });
    // The local turn was NOT hijacked into a resume/attach.
    expect(h.state.resumeStream).not.toHaveBeenCalled();
  });

  it("strips the streaming tail from the seed, keeps a user tail whole", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    expect(h.state.seededMessages).toHaveLength(1);
    cleanup();
    resetState();
    renderThread({ autonomousRunsEnabled: true, initialRows: userTail() });
    expect(h.state.seededMessages).toHaveLength(1);
  });

  it("builds the attach URL with expect=live&anchor only for a stripped streaming tail", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    expect(h.state.transport!.prepareReconnectToStreamRequest!().api).toBe(
      "/api/ai-chat/runs/c1/stream?expect=live&anchor=a1",
    );
    cleanup();
    resetState();
    renderThread({ autonomousRunsEnabled: true, initialRows: userTail() });
    expect(h.state.transport!.prepareReconnectToStreamRequest!().api).toBe(
      "/api/ai-chat/runs/c1/stream",
    );
  });

  async function attachFetch(response: unknown, reject = false) {
    vi.stubGlobal(
      "fetch",
      reject
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response),
    );
    await act(async () => {
      await h.state
        .transport!.fetch!("http://x", { method: "GET" })
        .catch(() => undefined);
    });
  }

  it("204 on a streaming tail: restore + invalidate + onResumeFallback(true)", async () => {
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    await attachFetch({ status: 204, ok: false });
    expect(h.state.setMessages).toHaveBeenCalledTimes(1); // restore
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
  });

  it("F7 restart-survival: a 500 attach failure restores the row AND arms the poll", async () => {
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    await attachFetch({ status: 500, ok: false });
    expect(h.state.setMessages).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
  });

  it("F7 restart-survival: a network throw restores the row AND arms the poll", async () => {
    const { onResumeFallback, invalidateSpy } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    await attachFetch(new Error("network down"), true);
    expect(h.state.setMessages).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["ai-chat-messages", "c1"],
    });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
  });

  it("unmount during a pending attach aborts the controller and gates late callbacks (epoch I1)", async () => {
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
    let pending!: Promise<unknown>;
    act(() => {
      pending = h.state.transport!.fetch!("http://x", { method: "GET" });
    });
    unmount(); // DISPOSE aborts the attach + bumps the epoch
    expect(abortSeen).toBe(true);
    onResumeFallback.mockClear();
    invalidateSpy.mockClear();
    await act(async () => {
      resolveFetch({ status: 204, ok: false });
      await pending;
    });
    // The stale (superseded-epoch) outcome is dropped.
    expect(onResumeFallback).not.toHaveBeenCalledWith(true);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("a resumed (observer) turn's onFinish does NOT flush the queue", () => {
    renderThread({ autonomousRunsEnabled: true, initialRows: streamingTail() });
    fireEvent.click(screen.getByTestId("queue-btn"));
    act(() => {
      h.state.onFinish?.({
        message: {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "streamed answer" }],
        },
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.sendMessage).not.toHaveBeenCalled();
  });

  it("an empty resumed message (starved replay) restores the row AND arms the poll", () => {
    h.state.status = "ready";
    const { onResumeFallback } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    h.state.setMessages.mockClear();
    onResumeFallback.mockClear();
    act(() => {
      h.state.onFinish?.({
        message: { id: "a1", role: "assistant", parts: [] },
        isAbort: false,
        isDisconnect: false,
        isError: false,
      });
    });
    expect(h.state.setMessages).toHaveBeenCalledTimes(1); // restore
    expect(onResumeFallback).toHaveBeenCalledWith(true); // arm
  });

  it("handleStop aborts the attach controller and calls onServerStop", () => {
    const { onServerStop } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(),
    });
    let abortSeen = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_input: unknown, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => {
          abortSeen = true;
        });
        return new Promise(() => undefined);
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

// -----------------------------------------------------------------------------
// Live reconnect (#430) + #488 commits 2/3 + stalled (4a). Fake timers.
// -----------------------------------------------------------------------------
describe("ChatThread — live reconnect + stalled", () => {
  const liveMsg = {
    id: "a2",
    role: "assistant",
    parts: [{ type: "text", text: "partial live answer" }],
  };

  beforeEach(() => {
    resetState();
    h.state.status = "ready";
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  // A REAL live SSE drop. ai@6.0.207 emits BOTH { isError:true, isDisconnect:true }
  // for a network TypeError AND sets useChat `error` — NOT the { isError:false,
  // error:null } form the old tests fed. This is the form browser QA hit; with the
  // buggy isError-first routing OR without the errorView render-gate these tests go
  // red (a real drop surfaces the terminal error banner, masking the reconnect
  // ladder). MUTATION-VERIFY of disconnect-first + the errorView phase-gate.
  function disconnect(message: unknown = liveMsg) {
    h.state.error = { message: "Failed to fetch" }; // the SDK sets error on the drop
    act(() => {
      h.state.onFinish?.({
        message,
        isAbort: false,
        isDisconnect: true,
        isError: true,
      });
    });
  }
  function renderLive() {
    const view = renderThread({
      autonomousRunsEnabled: true,
      initialRows: settledTail(),
    });
    expect(h.state.resumeStream).not.toHaveBeenCalled();
    return view;
  }
  function advanceToAttempt(attempt: number) {
    act(() => {
      vi.advanceTimersByTime(1000 * 2 ** (attempt - 1));
    });
  }
  async function reconnect(response: unknown) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await act(async () => {
      await h.state.transport!.fetch!("http://x", { method: "GET" });
    });
  }

  it("a live disconnect starts a backoff reconnect (banner + resumeStream after backoff)", () => {
    renderLive();
    disconnect();
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
    expect(h.state.resumeStream).not.toHaveBeenCalled();
    advanceToAttempt(1);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
    expect(h.state.transport!.prepareReconnectToStreamRequest!().api).toBe(
      "/api/ai-chat/runs/c1/stream?expect=live&anchor=a2",
    );
  });

  it("#488 (browser QA): the reconnect banner is SHOWN, not masked by the residual useChat error", () => {
    // The drop sets useChat `error` (real SDK), and the terminal errorView describes
    // it ("Lost connection to the server"). The FSM phase-gate must let the
    // `reconnecting` banner WIN over that residual error. MUTATION-VERIFY: revert the
    // errorView phase-gate (show errorView whenever error is set) and the terminal
    // banner masks "reconnecting…" -> red.
    renderLive();
    disconnect();
    expect(h.state.error).not.toBeNull(); // the SDK error IS set during recovery
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
    // The terminal "Lost connection… reload" banner must NOT be showing.
    expect(screen.queryByText(/reload and try again/i)).toBeNull();
  });

  it("#488 commit 2: a disconnect BEFORE the first assistant frame reconnects with NO anchor", () => {
    renderLive();
    disconnect(null); // no assistant message yet (pre-first-frame break)
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
    expect(
      screen.queryByText("Connection lost — the answer was interrupted."),
    ).toBeNull();
    advanceToAttempt(1);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
    expect(h.state.transport!.prepareReconnectToStreamRequest!().api).toBe(
      "/api/ai-chat/runs/c1/stream",
    );
  });

  it("a live re-attach (2xx) clears the reconnect banner", async () => {
    renderLive();
    disconnect();
    advanceToAttempt(1);
    await reconnect({ status: 200, ok: true });
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
  });

  it("a 204 arms the degraded poll and backs off to the next attempt", async () => {
    const { onResumeFallback } = renderLive();
    disconnect();
    advanceToAttempt(1);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
    await reconnect({ status: 204, ok: false });
    expect(onResumeFallback).toHaveBeenCalledWith(true);
    expect(screen.getByText(/reconnecting.*2\/5/i)).toBeTruthy();
    advanceToAttempt(2);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(2);
  });

  it("exhausts the attempt limit into a manual Retry, which restarts the sequence", async () => {
    renderLive();
    disconnect();
    for (let n = 1; n <= 5; n++) {
      advanceToAttempt(n);
      expect(h.state.resumeStream).toHaveBeenCalledTimes(n);
      await reconnect({ status: 204, ok: false });
    }
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
    const retry = screen.getByText("Retry");
    act(() => {
      fireEvent.click(retry);
    });
    expect(h.state.resumeStream).toHaveBeenCalledTimes(6);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });

  it("#488 commit 3: two breaks in a row produce two reconnect cycles", async () => {
    renderLive();
    // First break -> reconnect -> re-attach live.
    disconnect();
    advanceToAttempt(1);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(1);
    await reconnect({ status: 200, ok: true });
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
    // The re-attached observer stream drops AGAIN -> a SECOND reconnect cycle
    // (the old one-shot !wasResumed gate sent this to silent poll).
    disconnect();
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
    advanceToAttempt(1);
    expect(h.state.resumeStream).toHaveBeenCalledTimes(2);
  });

  it("does NOT reconnect when autonomous runs are disabled", () => {
    renderThread({ autonomousRunsEnabled: false, initialRows: settledTail() });
    disconnect();
    expect(screen.queryByText(/reconnecting/i)).toBeNull();
    expect(
      screen.getByText("Connection lost — the answer was interrupted."),
    ).toBeTruthy();
    advanceToAttempt(1);
    expect(h.state.resumeStream).not.toHaveBeenCalled();
  });

  it("#488 commit 4a: the poll idle cap surfaces a stalled banner + Retry (not silent)", async () => {
    renderLive();
    disconnect();
    advanceToAttempt(1);
    await reconnect({ status: 204, ok: false }); // arms the poll (reconnecting)
    // No activity for the whole idle cap -> stalled.
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(screen.getByText(/the run stopped responding/i)).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  it("#488 review-4: an observer-stop's armed poll is bounded by the idle cap (exits to idle, disarm)", () => {
    // STOP_REQUESTED arms the poll and enters `stopping`; an observer stop has no
    // SDK stream to fire onFinish, and the server stop may never drive the run
    // terminal. Without a backstop the DB would poll forever. The idle cap must give
    // `stopping` a bounded exit -> idle + disarm (NOT stalled). MUTATION-VERIFY: drop
    // `stopping` from the idle-cap effect / the POLL_IDLE_CAP branch -> no disarm.
    const { onResumeFallback } = renderThread({
      autonomousRunsEnabled: true,
      initialRows: streamingTail(), // mount attach -> observer
    });
    onResumeFallback.mockClear();
    fireEvent.click(screen.getByLabelText("Stop")); // STOP_REQUESTED -> stopping + armPoll
    expect(onResumeFallback).toHaveBeenCalledWith(true);
    onResumeFallback.mockClear();
    // No terminal row ever arrives; the inactivity cap bounds it.
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(onResumeFallback).toHaveBeenCalledWith(false); // POLL_IDLE_CAP -> idle -> disarm
  });
});
