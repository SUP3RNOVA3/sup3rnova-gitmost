import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateId } from "ai";
import { ActionIcon, Box, Group, Stack, Text, Tooltip } from "@mantine/core";
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
import { mergeObservedMessage } from "@/features/ai-chat/utils/run-polling.ts";
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
  /** #184 reconnect-and-live-follow. When THIS tab reopened a chat whose agent
   *  run is still going (it is a PASSIVE OBSERVER — it did not start the run here),
   *  the parent polls the reconnect endpoint and feeds the run's incrementally-
   *  persisted assistant message here; we merge it into the live list so new
   *  steps/tool-calls appear as they are persisted. Null when there is nothing to
   *  observe (no run, feature off, or this tab IS the streamer). The merge is
   *  ADDITIONALLY guarded by our own `isStreaming`, so a stale value can never
   *  fight the local stream when we are the streamer. */
  observedRow?: IAiChatMessageRow | null;
  /** Report this tab's live streaming status up to the parent, so it can stop
   *  polling the run while WE are the active streamer (the SSE owns the view) and
   *  resume once we go idle. Called from an effect on every transition. */
  onStreamingChange?: (streaming: boolean) => void;
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
  roleId,
  roles,
  onRolePicked,
  assistantName,
  onTurnFinished,
  onServerChatId,
  observedRow,
  onStreamingChange,
  autonomousRunsEnabled,
  onServerStop,
}: ChatThreadProps) {
  const { t } = useTranslation();

  const initialMessages = useMemo<UIMessage[]>(
    () => (initialRows ?? []).map(rowToUiMessage),
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
    sendMessageRef.current?.({ text: head.text });
    return true;
  }, [setQueue]);

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
              openPage: openPageRef.current,
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

  const { messages, sendMessage, status, stop, error, setMessages } = useChat({
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
      // Forward the authoritative server chatId (streamed on the assistant
      // message metadata) so the parent adopts the REAL created chat id for a new
      // chat — see adopt-chat-id.ts for the full #137 design. `threadKey` lets the
      // session ignore this finish if it belongs to a thread abandoned by New chat
      // mid-stream (#161).
      onTurnFinished(extractServerChatId(message), threadKey);
      // Show a neutral "stopped" marker for an aborted turn; the red error banner
      // (via `error`) already covers isError, and a clean finish clears any marker.
      if (isError) setStopNotice(null);
      else if (isAbort) setStopNotice("manual");
      else if (isDisconnect) setStopNotice("disconnect");
      else setStopNotice(null);
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
        // tag so it can't leak onto the next unrelated send. On a real send the
        // tag is consumed by prepareSendMessagesRequest and stays untouched.
        if (!flushNext()) interruptNextSendRef.current = false;
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

  // #184: report our live streaming status up so the parent stops polling the run
  // while WE are the streamer (the SSE owns the view) and resumes once we go idle.
  // Effect (not render) so it never updates parent state during our own render;
  // fires on mount with `false`, which also re-syncs the parent after a chat
  // switch remounts this thread (a fresh mount is idle until the user sends).
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // #184 passive-observer merge: when the parent feeds a polled run message (we
  // reopened a chat whose run is still going and did NOT start it here), merge it
  // into the live list so new steps/tool-calls appear as they are persisted. Hard-
  // gated by `!isStreaming`: if THIS tab is actually the streamer, the local SSE
  // owns the view and a stale observedRow must never overwrite it. `observedRow`
  // is a stable per-poll object, so this runs once per poll, not per render.
  useEffect(() => {
    if (isStreaming || !observedRow) return;
    const observed = rowToUiMessage(observedRow);
    setMessages((prev) => mergeObservedMessage(prev, observed));
  }, [observedRow, isStreaming, setMessages]);

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
        stop(); // -> onFinish({ isAbort: true }) flushes the promoted head
      } else {
        // Nothing to interrupt: just send it now (no interrupt note).
        const msg = queuedRef.current.find((m) => m.id === id);
        if (!msg) return;
        setQueue(removeQueuedById(queuedRef.current, id));
        sendMessageRef.current?.({ text: msg.text });
      }
    },
    [setQueue, stop],
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
    stop();
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
  }, [stop, autonomousRunsEnabled, onServerStop]);

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
          onSend={(text) => sendMessage({ text })}
          onQueue={enqueue}
          onStop={handleStop}
          isStreaming={isStreaming}
        />
      </Stack>
    </Box>
  );
}
