import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { generateId } from "ai";
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconClockHour4,
  IconPlayerPlayFilled,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import MessageList from "@/features/ai-chat/components/message-list.tsx";
import ChatInput from "@/features/ai-chat/components/chat-input.tsx";
import RoleCards from "@/features/ai-chat/components/role-cards.tsx";
import ChatErrorAlert from "@/features/ai-chat/components/chat-error-alert.tsx";
import ChatStoppedNotice from "@/features/ai-chat/components/chat-stopped-notice.tsx";
import {
  IAiChatMessageRow,
  IAiRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import {
  roleLaunchMessage,
  shouldResetRolePicked,
} from "@/features/ai-chat/utils/role-launch.ts";
import { describeChatError } from "@/features/ai-chat/utils/error-message.ts";
import { extractServerChatId } from "@/features/ai-chat/utils/adopt-chat-id.ts";
import { assistantMessageHasVisibleContent } from "@/features/ai-chat/utils/message-content.ts";
import {
  isStreamingTail,
  isSettledAssistantTail,
  seedRows,
  mergeById,
} from "@/features/ai-chat/utils/resume-helpers.ts";
import { AI_CHAT_MESSAGES_RQ_KEY } from "@/features/ai-chat/queries/ai-chat-query.ts";
import type { EditorSelectionContext } from "@/features/editor/utils/get-editor-selection.ts";
import {
  dequeue,
  enqueueMessage,
  promoteToHead,
  removeQueuedById,
  type QueuedMessage,
} from "@/features/ai-chat/utils/queue-helpers.ts";
import classes from "@/features/ai-chat/components/ai-chat.module.css";

// Throttle how often the streamed `messages` state triggers a re-render. Without
// it, useChat updates state on EVERY token, so the whole transcript's markdown
// (marked + DOMPurify) is re-parsed per token — on a long agent run that grows
// into a quadratic CPU storm that pins the main thread and freezes the UI.
// ~50ms (20 Hz) keeps streaming visually smooth while decoupling re-render cost
// from the token rate.
const STREAM_THROTTLE_MS = 50;

// #430: auto-reconnect after a LIVE SSE disconnect of a DETACHED (autonomous) run.
// The run keeps executing server-side, so instead of a dead "Lost connection"
// banner we re-attach to the live tail through the SAME resumable machinery the
// mount path uses. Attempts back off exponentially and are capped; on exhaustion
// the user gets a manual Retry (the degraded poll keeps catching up underneath).
const RECONNECT_MAX_ATTEMPTS = 5;
// Backoff before attempt N (1-based): 1s, 2s, 4s, 8s, 16s.
const RECONNECT_BASE_DELAY_MS = 1000;

// #396: bounded retry for the "Interrupt and send now" re-send when it races the
// authoritative server stop of the just-superseded detached run. The re-POST can
// arrive before the old run has released the one-active-run slot, so the server
// returns 409 A_RUN_ALREADY_ACTIVE. The server stop guarantees the slot frees, so
// a few short backoffs converge. 4 total attempts: attempt 1 fires immediately,
// then these are the waits BEFORE attempts 2, 3 and 4 (150ms, 300ms, 600ms). If
// all 4 attempts 409, the last 409 surfaces (the banner) — acceptable per #396.
const SUPERSEDE_RETRY_DELAYS_MS = [150, 300, 600];
// The server error code that means "another run is already active for this chat".
const A_RUN_ALREADY_ACTIVE = "A_RUN_ALREADY_ACTIVE";

/**
 * #396: defensively decide whether a 409 response is the one-active-run gate
 * rejection (code A_RUN_ALREADY_ACTIVE) vs. some other 409. Reads a CLONE so the
 * original response body stays intact for the caller when it is returned as-is.
 * Any parse failure or unexpected shape => false (do NOT retry).
 */
async function isRunAlreadyActive(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as unknown;
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { code?: unknown }).code === A_RUN_ALREADY_ACTIVE
    );
  } catch {
    return false;
  }
}

/** The page the user is currently viewing, sent as chat context. */
export interface OpenPageContext {
  id: string;
  title: string;
}

interface ChatThreadProps {
  /** The open chat id, or null for a brand-new (not-yet-created) chat. */
  chatId: string | null;
  /** This thread's mount key (the same value the parent uses as React `key`).
   *  Forwarded to onTurnFinished so the session can tell a turn finishing on the
   *  CURRENT thread from one ABANDONED by New chat mid-stream — whose onFinish/
   *  onError still fire after unmount and must not adopt the abandoned chat (#161). */
  threadKey?: string;
  /** Persisted rows to seed initial messages (existing chats only). */
  initialRows?: IAiChatMessageRow[];
  /** The page currently open in the workspace, or null on a non-page route.
   *  Sent with each turn so the agent knows what "this page" refers to. */
  openPage?: OpenPageContext | null;
  /** #388: snapshot the user's current editor selection at SEND time. Invoked
   *  inside prepareSendMessagesRequest and nested into openPage on the wire, so a
   *  fresh snapshot ships each turn. Null/absent => nothing selected. */
  getEditorSelection?: () => EditorSelectionContext | null;
  /** The agent role selected for a NEW chat (null = universal assistant). Sent
   *  in the request body so the server persists it on chat creation; ignored by
   *  the server for existing chats (the role is read from the chat row). */
  roleId?: string | null;
  /** Enabled roles for the new-chat empty state (only meaningful when
   *  `chatId === null`). Rendered as the colored role cards. */
  roles?: IAiRole[];
  /** Notify the parent which role was picked via a card, so it can update the
   *  header badge / assistant name for the brand-new chat. */
  onRolePicked?: (role: IAiRole) => void;
  /** Display name for the assistant label / typing line (the role name);
   *  forwarded to MessageList. Absent => the generic "AI agent". */
  assistantName?: string;
  /** Called when a turn finishes; the parent refreshes the chat list and, for a
   *  new chat, adopts the freshly created chat id. `serverChatId` is the
   *  authoritative id the server streamed on the assistant message metadata, or
   *  undefined on a failed turn — see adopt-chat-id.ts for the full #137 design.
   *  `finishingThreadKey` (this thread's mount key) lets the session ignore a turn
   *  finishing on a thread already abandoned by New chat mid-stream (#161). */
  onTurnFinished: (serverChatId?: string, finishingThreadKey?: string) => void;
  /** Called EARLY (at the stream's `start` chunk) with the authoritative server
   *  chat id streamed on the assistant message metadata, so a brand-new chat
   *  adopts its real id WHILE the first turn is still streaming (#174 — makes the
   *  Copy/export button available mid-stream). Distinct from onTurnFinished,
   *  which fires only at the terminal outcome. */
  onServerChatId?: (serverChatId?: string) => void;
  /** #184 phase 1.5: arm/disarm the parent's degraded-poll fallback for THIS
   *  chat's window. Called `true` when a resume attempt could not attach to the
   *  live run (attach 204 / starved-or-torn resumed finish), so the window starts
   *  a dumb timed poll of the message history to follow the detached run to settle;
   *  called `false` the moment a local stream starts or the terminal settled row is
   *  merged (invariant 8). The window owns the timer + its 10-min cap. */
  onResumeFallback?: (active: boolean) => void;
  /** #184: whether detached/autonomous agent runs are enabled for this workspace.
   *  When true the Stop button must additionally hit the AUTHORITATIVE server stop
   *  (via onServerStop) — aborting only the local SSE is just a client disconnect,
   *  which the server deliberately ignores, so the detached run would keep going. */
  autonomousRunsEnabled?: boolean;
  /** #184: request the server-side stop of this chat's active run (the parent owns
   *  the endpoint call + the "stopping" latch that keeps observer-polling from
   *  immediately re-streaming the stopping run's output). Called with the resolved
   *  chat id when the user presses Stop in autonomous mode. */
  onServerStop?: (chatId: string) => void;
}

/**
 * Map a persisted server row to an AI SDK UIMessage. Mirrors the server's
 * `rowToUiMessage`: `metadata.parts` are the UIMessage parts; otherwise fall
 * back to a single text part built from the plain-text `content`.
 */
function rowToUiMessage(row: IAiChatMessageRow): UIMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  const parts =
    Array.isArray(row.metadata?.parts) && row.metadata.parts.length > 0
      ? row.metadata.parts
      : ([{ type: "text", text: row.content ?? "" }] as UIMessage["parts"]);
  const error = row.metadata?.error;
  const finishReason = row.metadata?.finishReason;
  const metadata: Record<string, unknown> = {};
  if (error) metadata.error = error;
  if (finishReason) metadata.finishReason = finishReason;
  return {
    id: row.id,
    role,
    parts,
    // Carry persisted turn outcome (error text and/or finishReason) so MessageItem
    // can render the error banner / "stopped" marker after a remount and in
    // reopened history.
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  } as UIMessage;
}

/**
 * Owns the AI SDK `useChat` lifecycle for ONE chat. The parent remounts this
 * with a `key` when the selected chat changes, so initial messages re-seed
 * cleanly (the v6 transport-based hook keeps its state per mount).
 */
export default function ChatThread({
  chatId,
  threadKey,
  initialRows,
  openPage,
  getEditorSelection,
  roleId,
  roles,
  onRolePicked,
  assistantName,
  onTurnFinished,
  onServerChatId,
  onResumeFallback,
  autonomousRunsEnabled,
  onServerStop,
}: ChatThreadProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // resume machinery refs (#184 phase 1.5)
  const attachAbortRef = useRef<AbortController | null>(null);
  const reconcileTailRef = useRef(false);
  const noStreamHandledRef = useRef(false);
  const onNoActiveStreamRef = useRef<(() => void) | null>(null);
  // #430: called from the transport's reconnect-GET success branch when a live
  // stream re-attached (2xx, not 204) — clears the reconnect banner. Kept in a ref
  // because the transport's fetch closure (useMemo([])) reads it live.
  const onReconnectAttachedRef = useRef<(() => void) | null>(null);
  // Live mount flag. The attach GET and the resumed `onFinish` are async and can
  // land AFTER this thread unmounts (the parent remounts per chat via `key`); with
  // chatIdRef then pointing at the NEW chat, an ungated late callback would arm a
  // spurious poll + foreign invalidation on the newly-opened chat. Every parent-
  // facing resume side-effect is gated on this.
  const mountedRef = useRef(true);
  const [resumedTurn, setResumedTurn] = useState(false);
  const resumedTurnRef = useRef(false);
  // Identity-stable pair setter (bare useState setter + ref write): it is closed
  // over by the transport useMemo([]), so it MUST NOT capture state.
  const setResumedTurnPair = useCallback((v: boolean) => {
    resumedTurnRef.current = v;
    setResumedTurn(v);
  }, []);

  // Mount-time resume gating (in refs — computed once for this mount; the parent
  // remounts per chat via `key`).
  //
  // Attempt resume for any non-settled tail: a streaming tail (strip + expect
  // live replay) or a user tail (the run may exist but its assistant row is not
  // seeded yet — attach to the pre-opened registry entry and wait for frames).
  // A settled assistant tail must NEVER resume: replaying a finished run into a
  // store that already contains its message duplicates parts (SDK text-start
  // always pushes a new part).
  const stripRef = useRef(chatId !== null && isStreamingTail(initialRows ?? []));
  const attemptResumeRef = useRef(
    autonomousRunsEnabled === true &&
      chatId !== null &&
      !isSettledAssistantTail(initialRows ?? []),
  );
  const strippedRowRef = useRef<IAiChatMessageRow | null>(
    stripRef.current ? (initialRows ?? [])[initialRows!.length - 1] : null,
  );

  const initialMessages = useMemo<UIMessage[]>(
    () =>
      seedRows(
        initialRows ?? [],
        attemptResumeRef.current && stripRef.current,
      ).map(rowToUiMessage),
    [initialRows],
  );

  // The server resolves/creates the chat from the `chatId` in the request body.
  // A new chat starts as null; we keep the id in a ref so the SAME hook instance
  // can keep streaming to a chat once it exists (the parent adopts the id on
  // finish, but within this mount the body carries whatever we know).
  const chatIdRef = useRef<string | null>(chatId);
  chatIdRef.current = chatId;

  // Keep the currently-open page in a ref, updated each render, so the LATEST
  // open page is sent on every send WITHOUT re-creating the `useMemo([])`-stable
  // transport (and thus without re-creating the useChat store mid-stream — see
  // the `chatStoreId` note below). Read live inside `prepareSendMessagesRequest`.
  const openPageRef = useRef<OpenPageContext | null>(openPage ?? null);
  openPageRef.current = openPage ?? null;

  // Keep the selection snapshotter in a ref, same rationale as openPageRef: the
  // transport useMemo([]) closes it over, so prop-identity churn must not matter.
  // Called at send time inside prepareSendMessagesRequest (#388).
  const getEditorSelectionRef = useRef<
    (() => EditorSelectionContext | null) | undefined
  >(getEditorSelection);
  getEditorSelectionRef.current = getEditorSelection;

  // Keep the selected role id in a ref, same rationale as openPageRef. Only the
  // FIRST request of a brand-new chat uses it (the server persists it then and
  // ignores it for existing chats), but sending it on every send is harmless.
  const roleIdRef = useRef<string | null>(roleId ?? null);
  roleIdRef.current = roleId ?? null;

  // Stable `useChat` store key for the lifetime of THIS mount.
  //
  // CRITICAL: `useChat` (@ai-sdk/react) re-creates its internal `Chat` store
  // whenever the `id` option no longer equals the store's current id
  // (`"id" in options && chatRef.current.id !== options.id`). For a brand-new
  // chat (`chatId === null`) we previously passed `id: undefined`; the store
  // then generated its OWN random id internally, so `store.id !== undefined`
  // stayed true on EVERY render and the store was re-created on every render —
  // wiping the optimistic user message, the "submitted" status, and every
  // streamed delta until the turn fully finished (then the parent adopts the
  // new chat id and remounts with the persisted history, making everything
  // "appear at once"). Passing a STABLE non-undefined id keeps one store for
  // the whole turn, so the user message shows immediately and tokens stream
  // live. This id is purely the client store key; the server still resolves the
  // real chat from `chatId` in the request body (see `prepareSendMessagesRequest`).
  // The id only needs to be stable per mount — the parent remounts this via
  // `key` on chat switch, which re-seeds cleanly.
  const stableIdRef = useRef<string>(chatId ?? `new-${generateId()}`);
  // Stable for the LIFETIME of this mount. When a brand-new chat adopts its
  // server id, the parent now updates the `chatId` prop WITHOUT remounting this
  // thread, so the store id must NOT follow `chatId`: recreating the useChat
  // store would wipe the live (just-finished) turn. The server still resolves
  // the real chat from `chatId` in the request body (see chatIdRef /
  // prepareSendMessagesRequest), so this purely-client store key can stay fixed.
  const chatStoreId = stableIdRef.current;

  // Pending messages the user composed WHILE a turn was streaming. They are sent
  // automatically, FIFO, on successful turn completion (`onFinish`). The queue is
  // LOCAL state so it is scoped to this conversation: it is cleared when the user
  // deliberately switches chat / starts a new chat (the parent remounts this via
  // `key`), but it SURVIVES in-place new-chat id adoption (no remount), so a
  // message queued during a brand-new chat's first turn is not lost. On Stop or
  // error the queue is intentionally preserved (onFinish does not fire then) so
  // the user decides what to do with the pending messages.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // Mirror the queue in a ref so the `onFinish` flush always reads the latest
  // queue without a stale closure; `setQueue` updates BOTH the ref and the state.
  const queuedRef = useRef<QueuedMessage[]>([]);
  const setQueue = useCallback((next: QueuedMessage[]) => {
    queuedRef.current = next;
    setQueued(next);
  }, []);

  // Capture the latest `sendMessage` (returned by useChat below) so the flush
  // helper can call the current instance from the stable `onFinish` callback.
  const sendMessageRef = useRef<((m: { text: string }) => void) | null>(null);

  // "Send now" single-flight flags. Kept in refs (not state) so they are read
  // inside the stable `onFinish` callback and the transport closure WITHOUT a
  // re-render or a stale closure. Both are one-shot (read-and-clear).
  // - flushOnAbortRef: flush the promoted head on the abort WE triggered, even
  //   though an aborted turn normally keeps the queue intact.
  // - interruptNextSendRef: tag the next send as a user interrupt so the server
  //   injects the "your previous answer was interrupted" note for that turn only.
  const flushOnAbortRef = useRef(false);
  const interruptNextSendRef = useRef(false);

  // #396: one-shot arm for the bounded 409 A_RUN_ALREADY_ACTIVE retry on the
  // "Interrupt and send now" re-send in autonomous mode. sendNow triggers the
  // authoritative server stop of the detached run, but that stop and the
  // onFinish->flushNext re-POST race: the new POST can hit the one-active-run
  // gate before the old detached run has settled, yielding a spurious 409. When
  // this ref is armed, the transport's send path retries that 409 with a short
  // bounded backoff (the server stop guarantees convergence). A normal send (ref
  // not armed) must STILL fail a 409 instantly (e.g. a genuine two-tab conflict).
  //
  // INVARIANT: sendNow arms this only to be consumed by the ONE re-POST that
  // flushNext fires from onFinish. But that re-POST does not always happen (the
  // promoted head may be gone, the finish may be a resumed turn, or the arm may
  // race a stale finish). To keep the arm strictly one-shot it is disarmed on
  // EVERY path where the paired interrupt one-shots (flushOnAbortRef /
  // interruptNextSendRef) are cleared without a POST: the transport POST branch
  // consumes it (read-and-clear), the onFinish `!flushNext()` no-send branch
  // clears it, and the isStreaming-defuse effect clears it symmetrically. So it
  // can never leak into a later, unrelated send and retry that send's genuine 409.
  const supersedeRetryRef = useRef(false);

  // #234 F5: the user pressed Stop while streaming a BRAND-NEW chat whose server
  // chat id has not been adopted yet (the `start` chunk carrying it hadn't landed
  // when Stop was pressed). A local SSE abort alone does NOT stop the DETACHED
  // autonomous run — it keeps burning tokens and WRITING TO PAGES — so we cannot
  // just no-op. We latch the stop as PENDING and fire the authoritative server
  // stop the moment onServerChatId adopts the id (below). Read-and-cleared there;
  // also defused on every new turn start so it can never fire against a later,
  // unrelated turn's run.
  const stopPendingRef = useRef(false);

  // FIFO dequeue + send the next queued message (no-op when the queue is empty).
  // Returns whether a message was actually sent, so callers can tell an empty
  // dequeue (nothing to flush) from a real send.
  const flushNext = useCallback(() => {
    const { head, rest } = dequeue(queuedRef.current);
    if (!head) return false;
    setQueue(rest);
    // Local send: clear any resume-suppression flag so this genuine local turn's
    // onFinish flushes normally (invariant 8).
    setResumedTurnPair(false);
    sendMessageRef.current?.({ text: head.text });
    return true;
  }, [setQueue, setResumedTurnPair]);

  const enqueue = useCallback(
    (text: string) => {
      setQueue(enqueueMessage(queuedRef.current, { id: generateId(), text }));
    },
    [setQueue],
  );
  const removeQueued = useCallback(
    (id: string) => {
      setQueue(removeQueuedById(queuedRef.current, id));
    },
    [setQueue],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: "/api/ai-chat/stream",
        credentials: "include",
        prepareReconnectToStreamRequest: () => ({
          // SDK default URL uses the useChat STORE id — always build from the real chat id.
          // ?expect=live&anchor=<row id> ONLY when we stripped a streaming tail: expect=live
          // is the only case where a finished-retained replay is safe (the row is stripped,
          // replay rebuilds it), and the anchor pins the replay to OUR run — a mismatching
          // (newer) run must 204 into the restore+poll path instead of replaying a foreign
          // transcript into this store.
          api: `/api/ai-chat/runs/${chatIdRef.current}/stream${
            stripRef.current
              ? `?expect=live&anchor=${strippedRowRef.current!.id}`
              : ""
          }`,
        }),
        fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
          if ((init.method ?? "GET") !== "GET") {
            // Send path (POST). #396: read-and-clear the one-shot supersede arm
            // here so it is strictly scoped to THIS send. When unarmed, behave
            // exactly as before — a single fetch, a 409 surfaces instantly (a
            // genuine two-tab conflict must NOT be retried).
            const supersede = supersedeRetryRef.current;
            supersedeRetryRef.current = false;
            if (!supersede) return fetch(input, init);
            // Buffer a ReadableStream body once so each retry can replay it.
            // DefaultChatTransport sends the body as a JSON STRING (replayable as
            // is), but guard defensively in case a future SDK streams it.
            let sendInit = init;
            if (init.body instanceof ReadableStream) {
              const buffered = await new Response(init.body).arrayBuffer();
              sendInit = { ...init, body: buffered };
            }
            // Bounded retry: attempt 1 fires immediately, then wait between
            // attempts per SUPERSEDE_RETRY_DELAYS_MS. Retry ONLY on a real
            // 409 A_RUN_ALREADY_ACTIVE; any other status/body is returned as-is.
            for (let attempt = 0; ; attempt++) {
              const response = await fetch(input, sendInit);
              if (
                response.status !== 409 ||
                attempt >= SUPERSEDE_RETRY_DELAYS_MS.length ||
                !(await isRunAlreadyActive(response))
              ) {
                return response;
              }
              // The old detached run has not released the one-active-run slot
              // yet; the server stop we requested guarantees it will, so back off
              // and re-POST (the 409 fired before the user message was persisted,
              // so re-POSTing is safe — no duplicate rows).
              await new Promise((r) =>
                setTimeout(r, SUPERSEDE_RETRY_DELAYS_MS[attempt]),
              );
            }
          }
          // Reconnect GET: the SDK passes no AbortSignal, so wire our own controller
          // for observer Stop / unmount abort.
          const controller = new AbortController();
          attachAbortRef.current = controller;
          try {
            const response = await fetch(input, {
              ...init,
              signal: controller.signal,
            });
            // No onFinish will come for a 204 (silent no-op) OR any non-2xx
            // (5xx/502 — a server restart mid-attach). Both run the same
            // no-active-stream recovery: restore the stripped row, invalidate, and
            // arm the degraded poll (idempotent via noStreamHandledRef; its part-d
            // also clears the resumedTurn flag). This is the restart-survival path
            // the removed F7 latch used to guard — a transient attach failure must
            // NOT drop the in-progress row or stop tracking the durable run.
            if (response.status === 204 || !response.ok)
              onNoActiveStreamRef.current?.();
            // #430: a 2xx stream re-attached (live tail or finished-replay). Signal
            // the reconnect controller to clear its banner. No-op outside an active
            // reconnect sequence (e.g. the mount attach), so it is safe here.
            else onReconnectAttachedRef.current?.();
            return response;
          } catch (err) {
            // Network throw: same no-onFinish recovery, then rethrow so the SDK
            // still surfaces the error to its own machinery.
            onNoActiveStreamRef.current?.();
            throw err;
          }
        },
        // Inject the chat id and the currently-open page alongside the useChat
        // messages so the server can resolve an existing chat (or create one
        // when null) and tell the agent which page "this page" refers to. Both
        // are read live from refs so changing chats/pages does NOT recreate the
        // transport. `openPage` is null on a non-page route.
        prepareSendMessagesRequest: ({ messages, body }) => {
          // Read-and-clear the interrupt flag so the "you were interrupted" note
          // is carried by ONLY this request (the one resending the promoted
          // message right after we aborted the previous turn). The server still
          // confirms it against history before acting on it.
          const interrupted = interruptNextSendRef.current;
          interruptNextSendRef.current = false; // one-shot
          return {
            body: {
              ...body,
              chatId: chatIdRef.current,
              // Attach the live editor selection to the open-page context at send
              // time — "this"/"here" in the user's message means THIS selection.
              // Nested inside openPage so it dies with the page when the server
              // rejects the page id (#388). Null when nothing is selected.
              openPage: openPageRef.current
                ? {
                    ...openPageRef.current,
                    selection: getEditorSelectionRef.current?.() ?? null,
                  }
                : null,
              // Honoured by the server only when creating a new chat; null =>
              // universal assistant.
              roleId: roleIdRef.current,
              interrupted,
              messages,
            },
          };
        },
      }),
    [],
  );

  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    setMessages,
    resumeStream,
  } = useChat({
    // Stable per-mount key. Existing chats use their real id; new chats use a
    // generated client id (never `undefined`) so the store is NOT re-created on
    // every render mid-stream (see `chatStoreId` above).
    id: chatStoreId,
    messages: initialMessages,
    transport,
    // See STREAM_THROTTLE_MS — bounds re-render/markdown-reparse frequency.
    experimental_throttle: STREAM_THROTTLE_MS,
    // `onFinish` (ai@6 useChat) fires from a `finally` on EVERY terminal outcome
    // — success, user Stop/abort (`isAbort`), network drop (`isDisconnect`), and
    // stream error (`isError`). Keep calling `onTurnFinished()` on all of them
    // (chat-list refresh + new-chat id adoption must happen even on a failed
    // first turn), but flush the pending queue ONLY on a clean finish: auto-
    // sending after the user hit Stop — or blindly retrying after a failure —
    // would be wrong, so on Stop/disconnect/error the queue is left intact for
    // the user to decide.
    onFinish: ({ message, isAbort, isDisconnect, isError }) => {
      // (1) Capture whether THIS finish belongs to a resumed (attach) turn and
      // immediately clear the flag so it can never suppress a LATER local turn.
      const wasResumed = resumedTurnRef.current;
      setResumedTurnPair(false);
      // (2) Recovery after a starved/torn resumed finish (invariant 9). The arm
      // and the stripped-row restore are gated DIFFERENTLY. Skip entirely once
      // unmounted (an abort-triggered onFinish landing after a chat switch must
      // not arm a poll / invalidate on the new chat).
      if (wasResumed && mountedRef.current) {
        const hasVisibleContent = assistantMessageHasVisibleContent(message);
        // ARM the reconcile + degraded poll when the resumed message carries no
        // visible content (starved replay) OR the connection dropped mid-run — in
        // both cases the poll must drive the row to its real terminal state.
        if (isDisconnect || !hasVisibleContent) {
          reconcileTailRef.current = true;
          queryClient.invalidateQueries({
            queryKey: AI_CHAT_MESSAGES_RQ_KEY(chatIdRef.current),
          });
          onResumeFallback?.(true);
        }
        // RESTORE the stripped streaming row ONLY when the resumed message has no
        // visible content. On isDisconnect WITH visible content restore is
        // FORBIDDEN: the live stream may have advanced far past the mount-time
        // snapshot, so restoring would clobber on-screen content (invariant 9) —
        // the arm above suffices, the poll reaches the true terminal.
        if (!hasVisibleContent && strippedRowRef.current) {
          setMessages((prev) =>
            mergeById(prev, rowToUiMessage(strippedRowRef.current!)),
          );
        }
      }
      // (2b) #430: a LIVE (non-resumed) detached run whose SSE just dropped. The
      // server run keeps executing, so instead of a dead "Lost connection" banner
      // start a reconnect sequence: pin the CURRENT streaming assistant row as the
      // strip/anchor (the live tail is the already-shown partial in `messages`, not
      // a persistent row) and re-attach to the live tail via the resumable machinery.
      const startedReconnect =
        isDisconnect &&
        !wasResumed &&
        autonomousRunsEnabled === true &&
        mountedRef.current &&
        message?.role === "assistant" &&
        typeof message.id === "string";
      if (startedReconnect) {
        beginReconnect({
          id: message.id,
          role: "assistant",
          content: "",
          status: "streaming",
          createdAt: new Date().toISOString(),
          // Preserve the partial parts so a 204 restore (onNoActiveStream) re-shows
          // what was on screen while the degraded poll catches the run up to
          // terminal (rowToUiMessage prefers metadata.parts).
          metadata: { parts: message.parts },
        });
      }
      // (3) Standard branches.
      // Forward the authoritative server chatId (streamed on the assistant
      // message metadata) so the parent adopts the REAL created chat id for a new
      // chat — see adopt-chat-id.ts for the full #137 design. `threadKey` lets the
      // session ignore this finish if it belongs to a thread abandoned by New chat
      // mid-stream (#161).
      onTurnFinished(extractServerChatId(message), threadKey);
      // Show a neutral "stopped" marker for an aborted turn; the red error banner
      // (via `error`) already covers isError, and a clean finish clears any marker.
      // On a live disconnect that STARTED a reconnect, suppress the terminal
      // "connection lost" notice — the reconnect banner takes over (#430).
      if (isError) setStopNotice(null);
      else if (isAbort) setStopNotice("manual");
      else if (isDisconnect) setStopNotice(startedReconnect ? null : "disconnect");
      else setStopNotice(null);
      // A resumed turn NEVER flushes the queue (invariant 7): skip BOTH the
      // flush-on-abort branch and the plain flush. The local streamer is the only
      // tab that owns the queue.
      if (wasResumed) return;
      // "Send now": WE triggered this abort to interrupt the current turn and
      // immediately send the promoted head. Flush it even though the turn was
      // aborted (the normal abort path below keeps the queue intact). The
      // interrupt note travels with this send via interruptNextSendRef.
      if (flushOnAbortRef.current) {
        flushOnAbortRef.current = false;
        // Suppress the "Response stopped." flash for an intentional interrupt.
        setStopNotice(null);
        // If the promoted head vanished (e.g. the user removed it before the
        // abort landed) flushNext sends nothing — clear the one-shot interrupt
        // tag AND the #396 supersede arm so neither can leak onto the next
        // unrelated send (no re-POST will consume the arm here). On a real send
        // the tag is consumed by prepareSendMessagesRequest and the arm by the
        // transport POST branch, so both stay untouched then.
        if (!flushNext()) {
          interruptNextSendRef.current = false;
          supersedeRetryRef.current = false;
        }
        return;
      }
      if (isAbort || isDisconnect || isError) return;
      flushNext();
    },
    // `onError` runs in addition to `onFinish` (which ai@6 also calls on error).
    // Log the raw failure here for devtools; the UI shows a friendly classified
    // banner via `error` below. We still call `onTurnFinished()` with NO server id
    // (idempotent with the onFinish call): for a brand-new chat that ARMS the
    // bounded list-refetch fallback (adopt the single newly-appeared chat once the
    // refetch lands); for an existing chat it just refreshes the chat list
    // immediately rather than after a manual refresh.
    onError: (streamError) => {
      // Surface the raw failure in the browser console (devtools) for debugging;
      // the UI separately shows a friendly classified banner (see errorView).
      console.error("AI chat stream error:", streamError);
      onTurnFinished(undefined, threadKey);
    },
  });

  // Keep the flush helper pointed at the latest sendMessage instance.
  sendMessageRef.current = sendMessage;

  // Mirror the live turn status in a ref so event handlers (sendNow) branch on the
  // CURRENT status rather than a value captured in a stale render closure — a turn
  // can finish between render and click, and arming the interrupt refs against a
  // no-op stop() would leave them set to leak into a later, unrelated Stop.
  const statusRef = useRef(status);
  statusRef.current = status;

  // EARLY chat-id adoption (#174): the server streams the authoritative chat id
  // on the assistant message metadata at the `start` chunk (message.metadata.
  // chatId — see adopt-chat-id.ts / chatStreamMetadata). Forward it to the parent
  // AS SOON AS it appears (mid-stream), so a brand-new chat adopts its real id
  // WHILE the first turn is still streaming and activeChatId-gated affordances
  // (the Copy/export button) light up immediately, instead of only at onFinish.
  // Keyed by the last-seen id so we forward each distinct id exactly once. The
  // parent's onServerChatId is idempotent and a no-op once the chat has an id.
  const lastForwardedChatIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!onServerChatId) return;
    const tail = messages[messages.length - 1];
    if (tail?.role !== "assistant") return;
    const serverChatId = extractServerChatId(tail);
    if (!serverChatId || serverChatId === lastForwardedChatIdRef.current)
      return;
    lastForwardedChatIdRef.current = serverChatId;
    onServerChatId(serverChatId);
    // #234 F5: if Stop was pressed before the id was known, the authoritative
    // server stop was deferred to this adoption point — fire it now with the
    // just-adopted id. One-shot (read-and-clear) so it can't fire twice.
    if (stopPendingRef.current) {
      stopPendingRef.current = false;
      onServerStop?.(serverChatId);
    }
  }, [messages, onServerChatId, onServerStop]);

  // Live "turn was interrupted" marker for the CURRENT session. The red error
  // banner (driven by `error`) covers the error case; this covers an aborted
  // turn, distinguishing a manual Stop (`isAbort`) from a dropped connection
  // (`isDisconnect`) — a distinction only available live (the server persists
  // both as finishReason 'aborted'). Cleared when the next turn starts.
  const [stopNotice, setStopNotice] = useState<null | "manual" | "disconnect">(
    null,
  );

  const isStreaming = status === "submitted" || status === "streaming";

  // #430: live-disconnect reconnect controller. `null` = idle; `{ trying, attempt }`
  // = a backoff sequence is running (drives the "reconnecting… (N/max)" banner);
  // `{ failed }` = attempts exhausted (drives the manual Retry). Mirrored into a ref
  // so the transport/onNoActiveStream closures branch on the LIVE value.
  type ReconnectState =
    | null
    | { phase: "trying"; attempt: number }
    | { phase: "failed" };
  const [reconnectState, setReconnectState] = useState<ReconnectState>(null);
  const reconnectStateRef = useRef<ReconnectState>(null);
  const setReconnectStatePair = useCallback((s: ReconnectState) => {
    reconnectStateRef.current = s;
    setReconnectState(s);
  }, []);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  // One reconnect attempt — MIRRORS the mount strip/anchor path for the LIVE case.
  // beginReconnect pinned strippedRowRef/stripRef to the run's assistant row, so:
  //  - remove that row from the store (the mount path strips it from the SEED; here
  //    it is already shown, so filter it out) — the live replay's `text-start` then
  //    rebuilds it without DUPLICATING parts (the main dedup risk, #430);
  //  - reset the one-shot 204 guard so onNoActiveStream can fire for THIS attempt;
  //  - mark the turn resumed (invariant 7/8) so onFinish runs the recovery block and
  //    never flushes the queue;
  //  - resumeStream() -> prepareReconnectToStreamRequest builds
  //    ?expect=live&anchor=<pinned id>, pinning the replay to OUR run (invariant 6).
  const attemptReconnectOnce = useCallback(
    (attempt: number) => {
      if (!mountedRef.current) return;
      const anchor = strippedRowRef.current;
      if (anchor) {
        setMessages((prev) => prev.filter((m) => m.id !== anchor.id));
      }
      noStreamHandledRef.current = false;
      setResumedTurnPair(true);
      setReconnectStatePair({ phase: "trying", attempt });
      void resumeStream();
    },
    [setMessages, setResumedTurnPair, setReconnectStatePair, resumeStream],
  );

  // Schedule attempt `attempt` after an exponential backoff.
  const scheduleReconnectAttempt = useCallback(
    (attempt: number) => {
      clearReconnectTimer();
      setReconnectStatePair({ phase: "trying", attempt });
      reconnectTimerRef.current = setTimeout(
        () => attemptReconnectOnce(attempt),
        RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
      );
    },
    [clearReconnectTimer, setReconnectStatePair, attemptReconnectOnce],
  );

  // Start a fresh reconnect sequence, pinning `anchorRow` (the live run's assistant
  // row) as the strip/anchor reused by every attempt.
  const beginReconnect = useCallback(
    (anchorRow: IAiChatMessageRow) => {
      if (!autonomousRunsEnabled || !mountedRef.current) return;
      strippedRowRef.current = anchorRow;
      stripRef.current = true;
      scheduleReconnectAttempt(1);
    },
    [autonomousRunsEnabled, scheduleReconnectAttempt],
  );

  // Manual Retry (shown once attempts are exhausted): restart at attempt 1 and fire
  // immediately (the user asked for it now — no backoff).
  const retryReconnect = useCallback(() => {
    clearReconnectTimer();
    attemptReconnectOnce(1);
  }, [clearReconnectTimer, attemptReconnectOnce]);

  // Live SSE re-attached (the reconnect GET returned a 2xx stream): clear the
  // banner + any pending backoff. No-op outside a sequence (e.g. the mount attach).
  const onReconnectAttached = useCallback(() => {
    if (!mountedRef.current || !reconnectStateRef.current) return;
    clearReconnectTimer();
    setReconnectStatePair(null);
  }, [clearReconnectTimer, setReconnectStatePair]);
  onReconnectAttachedRef.current = onReconnectAttached;

  // The reconnect GET could not attach (204 / error). onNoActiveStream has already
  // armed the degraded poll (the robust fallback that drives the row to terminal
  // from the DB), so this only decides the LIVE-attach retry: back off and try
  // again up to the cap, else surface the manual Retry.
  const onReconnectNoStream = useCallback(() => {
    const s = reconnectStateRef.current;
    if (s?.phase !== "trying") return;
    if (s.attempt < RECONNECT_MAX_ATTEMPTS)
      scheduleReconnectAttempt(s.attempt + 1);
    else setReconnectStatePair({ phase: "failed" });
  }, [scheduleReconnectAttempt, setReconnectStatePair]);

  // 204-handler (`onNoActiveStream`): the attach returned 204 — nothing live to
  // resume (overflow / begin-failure / after retention / anchor-mismatch). One-
  // shot via noStreamHandledRef (we do NOT null onNoActiveStreamRef). Exactly four
  // parts. Kept in a ref (read by the transport's fetch closure) and refreshed
  // each render below.
  const onNoActiveStream = useCallback(() => {
    // A late attach outcome after unmount must not arm a poll / invalidate on the
    // now-different chat this thread's refs were reused for.
    if (!mountedRef.current) return;
    if (noStreamHandledRef.current) return;
    noStreamHandledRef.current = true;
    // (a) Restore the stripped streaming row to the store — ONLY when we actually
    // stripped one (a user-tail 204 does NOT reach here with a stripped row, so do
    // not dereference null).
    if (strippedRowRef.current) {
      setMessages((prev) =>
        mergeById(prev, rowToUiMessage(strippedRowRef.current!)),
      );
    }
    // (b) Reconcile the tail from the message history + invalidate it so the
    // degraded poll starts from a fresh fetch.
    reconcileTailRef.current = true;
    queryClient.invalidateQueries({
      queryKey: AI_CHAT_MESSAGES_RQ_KEY(chatIdRef.current),
    });
    // (c) Arm the degraded poll (a dumb timer with a 10-min cap in the window);
    // the thread disarms it via onResumeFallback(false) on settle / local stream.
    onResumeFallback?.(true);
    // (d) 204 means onFinish will NOT fire — clear the suppression flag so it
    // cannot swallow the NEXT local turn's queue flush.
    setResumedTurnPair(false);
    // (e) #430: if this 204/error landed during a live-disconnect reconnect
    // sequence, back off and retry the live attach (or give up to the manual
    // Retry). The degraded poll armed in (c) is the fallback either way.
    onReconnectNoStream();
  }, [
    setMessages,
    queryClient,
    onResumeFallback,
    setResumedTurnPair,
    onReconnectNoStream,
  ]);
  onNoActiveStreamRef.current = onNoActiveStream;

  // Mount effect: kick off the resume attempt for a non-settled tail. Marking the
  // turn as resumed BEFORE resumeStream so onFinish (invariant 7/8) sees it.
  useEffect(() => {
    // Re-arm on (re)mount — StrictMode dev-mounts twice, and the cleanup below
    // flips this false between the two.
    mountedRef.current = true;
    if (attemptResumeRef.current) {
      setResumedTurnPair(true);
      void resumeStream();
    }
    // Unmount: mark unmounted (gates late attach/onFinish side-effects) and abort
    // the in-flight attach GET so its callbacks don't fire against the next chat.
    return () => {
      mountedRef.current = false;
      attachAbortRef.current?.abort();
      // #430: drop any pending reconnect backoff so it can't fire against the next
      // chat this thread's refs are reused for.
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
    // Mount-only by design; the parent remounts per chat via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconciliation + degraded-merge (invariant 8). Deps are EXACTLY
  // [initialRows, isStreaming, setMessages].
  useEffect(() => {
    // A local stream owns the view: disarm BOTH the merge and the window poll.
    if (isStreaming) {
      reconcileTailRef.current = false;
      onResumeFallback?.(false);
      return;
    }
    if (!reconcileTailRef.current) return;
    const rows = initialRows ?? [];
    const tail = rows[rows.length - 1];
    if (!tail || tail.role !== "assistant") return;
    // Merge the polled assistant tail on EVERY initialRows update — while the
    // degraded poll is active this IS the live per-step progress.
    setMessages((prev) => mergeById(prev, rowToUiMessage(tail)));
    // Anchor-mismatch coherence: when we restored a stripped streaming row A but a
    // DIFFERENT run's row B is now the tail (A finished, B replaced the registry
    // entry, so the attach 204'd), A would otherwise linger forever as an orphan
    // jumping-dots row over the real run. Settle it from fresh history (where A is
    // now persisted) so no phantom row survives. No-op in the common case where A
    // IS the tail (id match).
    const stripped = strippedRowRef.current;
    if (stripped && stripped.id !== tail.id) {
      const historical = rows.find((r) => r.id === stripped.id);
      if (historical)
        setMessages((prev) => mergeById(prev, rowToUiMessage(historical)));
    }
    // Settled: the terminal merge is done — disarm the flag AND the window poll
    // explicitly (the window only has a time cap, it will not disarm itself).
    if (tail.status !== "streaming") {
      reconcileTailRef.current = false;
      onResumeFallback?.(false);
      // #430: the run reached its terminal state via the degraded poll — there is
      // no live tail left to reconnect to, so drop any reconnect banner / Retry.
      clearReconnectTimer();
      setReconnectStatePair(null);
    }
    // onResumeFallback intentionally omitted (parent-stable callback); deps are
    // fixed by the resume design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRows, isStreaming, setMessages]);

  // #430: a real stream is live again — the reconnect re-attached to the live tail
  // (status -> "streaming") OR the user started a new local turn. Either way clear
  // the reconnect banner + any pending backoff. Gated on "streaming" (not the
  // broader "submitted") so a still-pending attach GET does not clear prematurely.
  useEffect(() => {
    if (status === "streaming") {
      clearReconnectTimer();
      setReconnectStatePair(null);
    }
  }, [status, clearReconnectTimer, setReconnectStatePair]);

  // "Send now" on a queued message: interrupt the current turn and immediately
  // send THIS message, keeping the agent's partial output. Other queued messages
  // stay queued and flush normally after the new turn. Reuses the existing
  // queue/flush machinery: promote the target to the head, then abort — the
  // onFinish flush-on-abort branch sends exactly that head, tagged as an
  // interrupt so the server notes the previous answer was cut off.
  const sendNow = useCallback(
    (id: string) => {
      // Branch on the LIVE status (statusRef), NOT the closure-captured isStreaming:
      // the turn may have finished between this render and the click, in which case
      // stop() is a no-op and arming the interrupt refs would strand them for a
      // later, unrelated Stop. Reading the ref always sees the current status.
      const liveStreaming =
        statusRef.current === "submitted" || statusRef.current === "streaming";
      if (liveStreaming) {
        // Promote to head so the onFinish -> flushNext path sends exactly it.
        setQueue(promoteToHead(queuedRef.current, id));
        flushOnAbortRef.current = true;
        interruptNextSendRef.current = true;
        // #396: in autonomous mode the turn is a DETACHED run — a local stop()
        // is only a client disconnect the server ignores, so the run keeps going.
        // The onFinish->flushNext re-POST would then hit the one-active-run gate
        // and get a spurious 409 A_RUN_ALREADY_ACTIVE. Mirror handleStop: request
        // the AUTHORITATIVE server stop so the detached run settles, and arm the
        // one-shot bounded 409 retry BEFORE stop() so the re-send converges once
        // the slot frees. Read chatId live from chatIdRef (adopted at the `start`
        // chunk). If it is not known yet (brand-new chat, first moment of its
        // first turn), defer the server stop via stopPendingRef exactly as
        // handleStop does — the onServerChatId adoption effect fires it once the
        // id lands; the retry stays armed so the re-send still converges then.
        if (autonomousRunsEnabled) {
          supersedeRetryRef.current = true; // arm the bounded 409 retry
          if (chatIdRef.current) {
            onServerStop?.(chatIdRef.current);
          } else {
            // Same #234-F5 sub-window limitation documented in handleStop: if the
            // local abort below cancels the reader before the `start` chunk lands,
            // the adoption effect never runs and the deferred stop never fires. Not
            // a regression; at minimum we don't strand refs (the isStreaming effect
            // defuses stopPendingRef on the next turn start).
            stopPendingRef.current = true;
          }
        }
        stop(); // -> onFinish({ isAbort: true }) flushes the promoted head
      } else {
        // Nothing to interrupt: just send it now (no interrupt note).
        const msg = queuedRef.current.find((m) => m.id === id);
        if (!msg) return;
        setQueue(removeQueuedById(queuedRef.current, id));
        // Local send: clear any resume-suppression flag (invariant 8).
        setResumedTurnPair(false);
        sendMessageRef.current?.({ text: msg.text });
      }
    },
    [setQueue, stop, setResumedTurnPair, autonomousRunsEnabled, onServerStop],
  );

  // Stop the current turn. ALWAYS abort the local SSE (`stop()`) so the composer
  // returns to idle immediately. In AUTONOMOUS mode the turn is a DETACHED run:
  // aborting the local SSE is only a client disconnect, which the server ignores,
  // so the run would keep executing — we ADDITIONALLY request the authoritative
  // server-side stop (the parent owns that call + the "stopping" latch that keeps
  // observer-polling from re-streaming the stopping run's output). The chat id is
  // read live from chatIdRef (adopted early at the stream's `start` chunk); if it
  // is not known yet — a brand-new chat in the first moment of its first turn —
  // only the local abort happens (there is no server-side run handle to stop yet).
  const handleStop = useCallback(() => {
    // Abort the resume/attach GET first: the SDK does not pass it a signal, so an
    // observer's Stop would otherwise leave the attach fetch running.
    attachAbortRef.current?.abort();
    stop();
    // #430: pressing Stop also cancels an in-progress reconnect sequence.
    clearReconnectTimer();
    setReconnectStatePair(null);
    if (!autonomousRunsEnabled) return;
    if (chatIdRef.current) {
      onServerStop?.(chatIdRef.current);
    } else {
      // #234 F5: no chat id yet (brand-new chat in the first moment of its first
      // turn, before the `start` chunk adopted the id). Latch the stop as pending;
      // the onServerChatId adoption effect fires the deferred server stop as soon
      // as the id appears, so the detached run is still authoritatively stopped
      // instead of left running by a silent local-only abort.
      //
      // KNOWN LIMITATION (#234 F5 review): `stop()` above has already aborted the
      // local SSE reader. In the rare sub-window where Stop is pressed while still
      // `submitted` (request sent, not one chunk read yet), that abort can cancel
      // the reader BEFORE the `start` chunk is applied to `messages`, so the
      // adoption effect never runs and this pending stop never fires. The detached
      // run then keeps going for that turn. This is not a regression (the pre-fix
      // behavior sent no server stop at all); closing it fully would require
      // deferring the local abort until adoption, which is riskier and out of scope
      // for this fix. Documented so a future change can address the abort-ordering.
      stopPendingRef.current = true;
    }
  }, [
    stop,
    autonomousRunsEnabled,
    onServerStop,
    clearReconnectTimer,
    setReconnectStatePair,
  ]);

  // Clear the stopped marker as soon as a new turn begins streaming, and drop any
  // stale "Send now" interrupt flags. On the legit interrupt path both refs are
  // already consumed synchronously (onFinish + prepareSendMessagesRequest) before
  // this effect runs, so clearing here is a no-op for it; its purpose is to defuse
  // the race where a flag was armed but the expected abort never fired (the turn
  // finished in the same tick as the click), so it cannot leak into a later turn.
  useEffect(() => {
    if (isStreaming) {
      setStopNotice(null);
      flushOnAbortRef.current = false;
      interruptNextSendRef.current = false;
      // #396: symmetric with the other one-shot interrupt flags — defuse a stale
      // supersede arm that was set but whose expected re-POST never fired (the
      // turn finished in the same tick as the click, or the promoted head was
      // gone), so it can never leak into this (or a later) turn's send and retry
      // that send's genuine 409. A legit arm is consumed by the transport POST
      // branch before this new turn streams, so this does not clobber it.
      supersedeRetryRef.current = false;
      // #234 F5: a new turn is starting — drop any pending deferred-stop from a
      // previous turn that never adopted an id, so it can never fire against this
      // (or a later) unrelated turn's run. A deferred stop for the CURRENT turn is
      // set AFTER this effect (on the Stop click), so this does not clobber it.
      stopPendingRef.current = false;
    }
  }, [isStreaming]);

  // Classify the turn error into a heading + detail so the banner names the cause
  // (connection reset, timeout, rate limit, context overflow, quota, ...) instead
  // of a generic "Something went wrong". Computed here (not only in the JSX) so
  // the SAME on-screen banner text can be mirrored into the export (issue #160).
  const errorView = error ? describeChatError(error.message ?? "", t) : null;

  // A role was picked with autoStart=false: the role is bound but NOTHING was
  // sent, so chatId stays null and the empty state would keep showing the cards.
  // This flag hides the cards and reveals the composer (with the role indicated)
  // so the user can type the first message themselves. roleIdRef is already set,
  // so that first manual message carries the roleId.
  const [rolePickedNoSend, setRolePickedNoSend] = useState(false);

  // Clicking a role card always binds the role to THIS new chat. Whether it also
  // auto-starts the conversation is per-role (autoStart). roleIdRef is set
  // synchronously here because the parent's selectedRoleId state update would
  // only reach roleIdRef on the next render — after this synchronous sendMessage
  // has already read it.
  const handleRolePick = (role: IAiRole): void => {
    roleIdRef.current = role.id;
    onRolePicked?.(role);
    const launch = roleLaunchMessage(
      role,
      t("Take a look at the current document"),
    );
    if (launch !== null) {
      sendMessage({ text: launch });
    } else {
      // autoStart=false -> bind only: hide the cards, show the composer.
      setRolePickedNoSend(true);
    }
  };
  // Reset the "picked, not sent" flag when the thread returns to a truly empty,
  // role-less state — e.g. the user hit "New chat" after picking an autoStart=false
  // role. That path clears the parent's selectedRoleId (roleId -> null) but leaves
  // chatId null, so the thread never remounts and the flag would stay set, hiding
  // the cards forever. A picked-and-bound role keeps roleId non-null, so the cards
  // correctly stay hidden then. Render-phase reset (React "adjust state on prop
  // change"): one-shot — it re-renders with the flag false and the guard no longer
  // matches, so it cannot loop. (Review of #149.)
  if (shouldResetRolePicked(chatId, roleId, rolePickedNoSend)) {
    setRolePickedNoSend(false);
  }
  const showRoleCards =
    chatId === null && (roles?.length ?? 0) > 0 && !rolePickedNoSend;
  const roleCardsEmptyState = showRoleCards ? (
    <RoleCards roles={roles ?? []} onPick={handleRolePick} />
  ) : undefined;

  return (
    <Box className={classes.panel}>
      <MessageList
        messages={messages}
        isStreaming={isStreaming}
        emptyState={roleCardsEmptyState}
        assistantName={assistantName}
      />

      {errorView ? (
        <ChatErrorAlert
          title={errorView.title}
          detail={errorView.detail}
          mb="xs"
        />
      ) : reconnectState ? (
        // #430: while auto-reconnecting to a detached run's live tail, show progress
        // instead of a dead "Lost connection" banner; once attempts are exhausted,
        // offer a manual Retry (the degraded poll keeps catching up underneath).
        <Alert
          variant="light"
          color="gray"
          p="xs"
          mb="xs"
          style={{ flexShrink: 0 }}
        >
          <Group gap={8} wrap="nowrap" align="center">
            {reconnectState.phase === "trying" ? (
              <>
                <Loader size={14} color="gray" style={{ flex: "none" }} />
                <Text size="sm" lh={1.3} c="dimmed">
                  {t("Connection lost — reconnecting…")}
                  {` (${reconnectState.attempt}/${RECONNECT_MAX_ATTEMPTS})`}
                </Text>
              </>
            ) : (
              <>
                <Text size="sm" lh={1.3} c="dimmed" style={{ flex: 1 }}>
                  {t("Couldn't reconnect to the answer.")}
                </Text>
                <Button
                  size="compact-xs"
                  variant="light"
                  color="gray"
                  onClick={retryReconnect}
                >
                  {t("Retry")}
                </Button>
              </>
            )}
          </Group>
        </Alert>
      ) : stopNotice ? (
        <ChatStoppedNotice
          text={
            stopNotice === "manual"
              ? t("Response stopped.")
              : t("Connection lost — the answer was interrupted.")
          }
          mb="xs"
        />
      ) : null}

      <Stack gap={0} className={classes.inputWrapper}>
        {queued.length > 0 && (
          <Stack gap={4} className={classes.queuedList}>
            {queued.map((m) => (
              <Group
                key={m.id}
                gap={6}
                wrap="nowrap"
                className={classes.queuedItem}
              >
                <IconClockHour4 size={14} className={classes.queuedIcon} />
                <Text size="xs" lineClamp={2} className={classes.queuedText}>
                  {m.text}
                </Text>
                {/* "Send now" (interrupt) is hidden on a RESUMED turn: a local
                    stop() does not abort the resumed attach fetch, so the click
                    would be swallowed while flushOnAbortRef would fire minutes
                    later on the natural finish. Only the remove affordance stays. */}
                {!resumedTurn && (
                  <Tooltip label={t("Interrupt and send now")} withArrow>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="blue"
                      onClick={() => sendNow(m.id)}
                      aria-label={t("Send now")}
                    >
                      <IconPlayerPlayFilled size={12} />
                    </ActionIcon>
                  </Tooltip>
                )}
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  onClick={() => removeQueued(m.id)}
                  aria-label={t("Remove queued message")}
                >
                  <IconX size={12} />
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        )}
        <ChatInput
          onSend={(text) => {
            // Local send: clear any resume-suppression flag (invariant 8).
            setResumedTurnPair(false);
            sendMessage({ text });
          }}
          onQueue={enqueue}
          onStop={handleStop}
          isStreaming={isStreaming}
        />
      </Stack>
    </Box>
  );
}
