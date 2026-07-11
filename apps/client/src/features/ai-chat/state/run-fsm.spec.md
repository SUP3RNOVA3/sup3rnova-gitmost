# AI-chat run-lifecycle FSM — design spec (#488)

This is the written design that `run-fsm.ts` implements. It ships in the PR (issue
#488 commit 1: "the spec is written FIRST and enters the PR"). It has four parts:
(1) the event × state transition table, (2) the map of every `chat-thread.tsx` ref
to {FSM state | FSM context | stays data}, (3) the run-fact protocol, (4) the
invariants.

The reducer is a **pure function** `reduce(machine, event) → machine`. The returned
machine carries the **command effects** for that transition; a thin runtime in
`chat-thread.tsx` dispatches events and executes effects. Because it is pure, the
whole machine is enumerable and unit-tested directly (event × state → next state is
the observable property) — see `run-fsm.test.ts`.

---

## 1. Event × state transition table

Phases: `idle | sending | streaming | attaching | reconnecting(attempt,failed) |
polling(reason) | stalled | stopping | superseding | error(kind)`.
Context (orthogonal): `epoch`, `ownership: local|observer`, `runFact: {runId}|null`.

Legend: **†** = command-transition (bumps `epoch`, I1). Effects in `[…]`.

| Event (source) | From phase(s) | → To phase | Effects / ctx |
|---|---|---|---|
| `SEND_LOCAL` (user send) | idle, error, polling, stalled, reconnecting | sending **†** | `[cancelReconnect, disarmPoll]`, ownership=local |
| `STREAM_START{runId}` (SDK `start` metadata) | sending, attaching, reconnecting, superseding | streaming | `[cancelReconnect, disarmPoll]`, runFact←runId |
| `FINISH_CLEAN` (onFinish clean) | streaming, … | idle | `[disarmPoll, cancelReconnect]`, runFact←null |
| `FINISH_ABORT` (onFinish isAbort) | streaming, stopping | idle | `[disarmPoll, cancelReconnect]`, runFact←null (I4 exits stopping by this DATA) |
| `FINISH_DISCONNECT{hasVisibleContent}` (onFinish isDisconnect) | streaming | reconnecting(1) **†** *iff runFact* | `[scheduleReconnect(1)]` (+`armPoll(disconnect-visible)` if visible), ownership=observer |
| `FINISH_DISCONNECT` (no runFact) | streaming | idle | runFact←null (plain terminal "connection lost") |
| `FINISH_ERROR{kind}` (onFinish isError) | any | error(kind) | `[disarmPoll, cancelReconnect]`, runFact←null |
| `ATTACH_START{runId}` (mount resume) | idle | attaching **†** | `[resumeStream]`, ownership=observer, runFact←runId |
| `ATTACH_LIVE` (attach GET 2xx) | attaching | streaming | — |
| `ATTACH_NONE` (attach GET 204/err/throw) | attaching | polling(attach-none) | `[armPoll(attach-none)]` |
| `RECONNECT_BEGIN` | streaming, idle | reconnecting(1) **†** *iff runFact* | `[scheduleReconnect(1)]`, ownership=observer |
| `RECONNECT_ATTEMPT{n}` (backoff timer) | reconnecting | reconnecting(n) **†** | `[resumeStream]` |
| `RECONNECT_ATTACHED` (reconnect GET 2xx) | reconnecting | streaming | `[cancelReconnect, disarmPoll]` — **counter reset** (commit 3) |
| `RECONNECT_NONE` (reconnect GET 204/err), attempt<MAX | reconnecting | reconnecting(n+1) **†** | `[armPoll(attach-none), scheduleReconnect(n+1)]` |
| `RECONNECT_NONE`, attempt=MAX | reconnecting | reconnecting(MAX, failed) | `[armPoll(reconnect-exhausted)]` |
| `RETRY` (manual, failed banner) | reconnecting(failed) | reconnecting(1) **†** | `[resumeStream]` |
| `RETRY` (manual, stalled banner) | stalled | polling(attach-none) **†** | `[armPoll]` |
| `POLL_ACTIVITY` (rows changed) | polling, reconnecting | (same) | — (runtime resets inactivity clock) |
| `POLL_TERMINAL` (settled tail merged) | polling, reconnecting, stopping | idle | `[disarmPoll, cancelReconnect]`, runFact←null (I4) |
| `POLL_IDLE_CAP` (inactivity cap) | polling, reconnecting | stalled | `[disarmPoll, cancelReconnect]` (commit 4a — no more silent) |
| `RUN_FACT{null}` (POST /run → null/terminal, 204) | reconnecting/attaching/polling/stopping | idle | `[cancelReconnect, disarmPoll]`, runFact←null (I3 fresh-negative gate) |
| `RUN_FACT{runId}` | any | (same) | runFact←runId (pessimism toward an attempt) |
| `STOP_REQUESTED` (user Stop) | streaming, reconnecting, polling | stopping **†** | `[stopRun, abortAttach, cancelReconnect]` |
| `SUPERSEDE_REQUESTED{targetRunId}` (interrupt+send) | streaming, reconnecting, polling, error | superseding **†** | `[supersede(target), cancelReconnect, disarmPoll]` |
| `SUPERSEDE_READY{runId}` (CAS ok) | superseding | streaming | ownership=local, runFact←runId |
| `SUPERSEDE_MISMATCH{currentRunId}` (409 SUPERSEDE_TARGET_MISMATCH) | superseding | error(supersede-mismatch) | `[postRun(verify)]`, runFact←currentRunId |
| `SUPERSEDE_TIMEOUT` (409 SUPERSEDE_TIMEOUT) | superseding | error(supersede-timeout) | — (composer keeps text; no auto-retry) |
| `SUPERSEDE_INVALID` (409 SUPERSEDE_INVALID) | superseding | error(supersede-invalid) | — |
| `RUN_ALREADY_ACTIVE` (409 A_RUN_ALREADY_ACTIVE, plain POST) | sending | error(run-already-active) | — (composer offers supersede; NO auto-retry) |
| `RUN_SUPERSEDED` (observer's run aborted by supersede) | streaming(observer), polling | attaching **†** | `[postRun(observer-follow)]`, ownership=observer |
| `DISPOSE` (unmount) | any | idle **†** | `[abortAttach, cancelReconnect, disarmPoll]` (I1/I5 — epoch++ kills late callbacks) |

**Epoch filter (I1):** the reducer FIRST drops any event carrying an `epoch` that
does not equal the current `ctx.epoch`. Outcome events (`STREAM_START`, `ATTACH_*`,
`RECONNECT_*`, `SUPERSEDE_*`, `FINISH_*`, `RUN_FACT`) are stamped with the epoch of
the command that could produce them; trigger events (user actions, fresh
disconnects) carry no epoch.

### 409-code → event map (the real #487 contract consumed here)

| Server response | Event dispatched | error kind → banner |
|---|---|---|
| 409 `A_RUN_ALREADY_ACTIVE` (plain POST) | `RUN_ALREADY_ACTIVE` | run-already-active → "already answering / interrupt & send" |
| 409 `SUPERSEDE_TARGET_MISMATCH` (+ body.runId) | `SUPERSEDE_MISMATCH{currentRunId}` | supersede-mismatch → verify via /run |
| 409 `SUPERSEDE_TIMEOUT` | `SUPERSEDE_TIMEOUT` | supersede-timeout → "couldn't interrupt in time, resend" |
| 409 `SUPERSEDE_INVALID` | `SUPERSEDE_INVALID` | supersede-invalid → "couldn't interrupt this run" |
| 503 `A_RUN_BEGIN_FAILED` | `FINISH_ERROR{begin-failed}` | begin-failed → "could not start, temporary" |

---

## 2. Ref-map — every `chat-thread.tsx` ref → its new home

(develop@363f20ab counted "26"; the branch already collapsed one during #486/#487,
so 25 refs are present today. Each is classified below; the run-lifecycle FLAGS
move into the FSM, the identity/data mirrors STAY as data — the post-merge rule
forbids only new **lifecycle-flag** refs.)

| # | Ref | Classification | Notes |
|---|---|---|---|
| 1 | `reconcileTailRef` | **FSM** (polling phase) | "poll is driving the tail" is `phase=polling` |
| 2 | `noStreamHandledRef` | **FSM ctx (epoch)** | one-shot 204 guard → epoch drops the stale second outcome |
| 3 | `onNoActiveStreamRef` | **FSM effect** | the transport dispatches `ATTACH_NONE`; no ref-callback |
| 4 | `onReconnectAttachedRef` | **FSM effect** | transport dispatches `RECONNECT_ATTACHED` / `ATTACH_LIVE` |
| 5 | `resumedTurnRef` | **FSM ctx (ownership)** | `ownership==='observer'` ⇒ resumed turn ⇒ never flush |
| 6 | `reconnectStateRef` | **FSM** (reconnecting phase) | `{trying,attempt}`/`{failed}` = `reconnecting(attempt,failed)` |
| 7 | `reconnectTimerRef` | **FSM effect** | `scheduleReconnect`/`cancelReconnect` own the timer |
| 8 | `flushOnAbortRef` | **FSM** (superseding/queue) | flush-on-abort is the superseding→READY / interrupt transition |
| 9 | `interruptNextSendRef` | **FSM ctx** (interrupt tag) | tag carried by the supersede/interrupt transition, one-shot via epoch |
| 10 | `supersedeRetryRef` | **REMOVED** (commit 5) | the client 409 retry ladder is deleted; CAS supersede replaces it |
| 11 | `stopPendingRef` | **FSM** (stopping deferral) | deferred stop is a `STOP_REQUESTED` pended on run-fact adoption |
| 12 | `mountedRef` | **FSM ctx (epoch)** + `DISPOSE` | unmount → `DISPOSE` bumps epoch; late callbacks dropped by I1 |
| 13 | `attemptResumeRef` | **FSM** (ATTACH_START decision) | armed ONLY on a server-confirmed run-fact (commit 4b) |
| 14 | `stripRef` | **data** (attachStrategy) | strip+replay strategy detail; effect-owned |
| 15 | `strippedRowRef` | **data** (attachStrategy) | the anchor row; effect-owned, aborts in cleanup |
| 16 | `attachAbortRef` | **FSM effect** (`abortAttach`) | controller owned by the attach effect, aborted in cleanup (I5) |
| 17 | `chatIdRef` | **data** (identity mirror) | stays; live chat id for the transport body |
| 18 | `openPageRef` | **data** | stays; live open-page for the send body |
| 19 | `getEditorSelectionRef` | **data** | stays; live selection snapshotter |
| 20 | `roleIdRef` | **data** | stays; live role id for the first send |
| 21 | `stableIdRef` | **data** | stays; the useChat store key (mount-stable) |
| 22 | `queuedRef` | **data** (queue) | stays; the queue is a data structure (decision #8) |
| 23 | `sendMessageRef` | **data** | stays; latest `sendMessage` for the flush |
| 24 | `statusRef` | **data** | stays; live SDK status mirror |
| 25 | `lastForwardedChatIdRef` | **data** (one-shot forward) | stays; dedupes the chat-id forward |

Run-lifecycle FLAGS eliminated by the FSM: #1–#13 (10 collapse into phase/ctx/effects;
#10 is deleted). Identity/data mirrors (#14–#25 minus the two attach-strategy/effect
items) intentionally stay — they are not lifecycle flags.

---

## 3. Run-fact protocol (`runFact: {runId} | null`) — I3

"A run is active" is first-class from the SERVER, not inferred from an assistant
message. Sources, in the order they update `ctx.runFact`:

1. **Init (mount):** `POST /ai-chat/run { chatId }` → `{ run, message }`. A `run`
   with a non-terminal `status` seeds `runFact = { runId: run.id }`; a null/terminal
   run seeds `null`. This is what arms the resume attempt (`ATTACH_START`) — the
   attempt is armed ONLY on a positive fact (commit 4b: a user-tail with no active
   run no longer arms a pointless poll on every open).
2. **Live update:** the `start` stream metadata carries `runId` → `STREAM_START{runId}`.
3. **Attach outcomes:** `ATTACH_LIVE` (2xx) confirms active; a 204 on a non-stripped
   path is an authoritative NEGATIVE fact → the runtime dispatches `RUN_FACT{null}`,
   which cancels recovery (I3 fresh-negative gate).
4. **Poll (future resume-stack iteration #491):** the delta will carry the run field;
   until then the poll drives to a terminal ROW, dispatched as `POLL_TERMINAL`.

Pessimism rule: a stale-but-positive fact PERMITS entering recovery (attach); the
204 then cuts it. A fresh negative fact gates recovery OUT immediately.

---

## 4. Invariants

- **I1 — Epoch (generation counter).** Every command-emitting transition bumps
  `ctx.epoch`; every async outcome event carries its issuing epoch; the reducer
  drops stale-epoch outcomes. Replaces the one-shot-ref zoo (`noStreamHandledRef`,
  the flush/interrupt/supersede one-shots, the `mountedRef` late-callback gate).
- **I2 — Ownership is context, not state.** `local | observer` is orthogonal to the
  transport phase. The queue flushes ONLY under local ownership; an observer
  following a detached run never flushes (was `resumedTurnRef`).
- **I3 — Run-fact is first-class from the server.** Reconnect is entered by the
  run-fact, not by an assistant message (commit 2). A fresh negative fact cancels
  recovery.
- **I4 — Exit `stopping` by DATA.** A terminal row / negative run-fact / terminal
  finish exits `stopping`, never the stopRun HTTP response (which returns after the
  abort but before finalization — keying off it would unlock the composer on a 409).
- **I5 — Dispose protocol.** Command controllers (attach GET, POST /stream, POST
  /run) are effect-owned and aborted in cleanup (`abortAttach` on `DISPOSE`), not
  render-phase refs. A client abort of an already-sent POST does not cancel the
  server action, so disarming on unmount is safe.
- **attachStrategy** (strip+replay today) is behind the `resumeStream` effect; the
  resume-stack iteration (#491) swaps it to tail-only WITHOUT touching the FSM.
- **Queue** stays a data structure; flush/interrupt decisions are transitions.
