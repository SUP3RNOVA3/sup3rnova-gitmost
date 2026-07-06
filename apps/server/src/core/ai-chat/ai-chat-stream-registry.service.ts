import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * In-memory run-stream registry (#184 phase 1.5). A durable agent run tees its
 * SSE frames here (via `pipeUIMessageStreamToResponse({ consumeSseStream })`)
 * so a LATE tab — one that reloaded, or opened after the starter dropped — can
 * attach through `GET /ai-chat/runs/:chatId/stream`, replay the frames buffered
 * so far, and then follow the live tail as a normal streamer.
 *
 * This is deliberately single-process and best-effort: it holds nothing the DB
 * does not (the run + assistant row are the source of truth), so a process
 * restart simply drops in-flight entries and the client falls back to its
 * restore + degraded-poll path. The async `attach` return type is the seam for a
 * future phase-2 cross-process backend (Redis) — the interface does not change.
 */

/** How long a finished entry is retained for late attach (replay + immediate end). */
export const RUN_STREAM_RETAIN_FINISHED_MS = 30_000;

/** Per-run replay buffer cap. Past this the buffer is dropped (attach -> 204). */
export const RUN_STREAM_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

// 2x the replay cap: a just-written 4MB replay burst alone can never trip the
// per-subscriber cap (see controller); only a genuinely stalled socket can.
export const SUBSCRIBER_MAX_BUFFERED_BYTES = 2 * RUN_STREAM_MAX_BUFFER_BYTES;

export interface RunStreamCallbacks {
  onFrame: (frame: string) => void;
  onEnd: () => void;
}

export interface RunStreamAttachment {
  replay: string[];
  finished: boolean;
  start(): void; // drain pending frames (order preserved) and go live
  unsubscribe(): void; // safe to call at any point, idempotent
}

interface Subscriber extends RunStreamCallbacks {
  started: boolean;
  pending: string[];
  // Byte size of `pending`, capped at SUBSCRIBER_MAX_BUFFERED_BYTES. `start()` is
  // called in the SAME tick as `attach()` today (see attach), so `pending` never
  // holds more than one microtask of frames — but the async `attach` signature is
  // a phase-2 seam: an await between attach and start would let a stalled paused
  // subscriber buffer the WHOLE run here. The cap is the structural backstop.
  pendingBytes: number;
  overflowed: boolean;
  pendingEnd: boolean;
}

interface Entry {
  runId: string;
  // The persisted assistant row id of this run (set at bind; undefined if the
  // seed failed). Used by the attach anchor check (invariant 6).
  assistantMessageId?: string;
  frames: string[];
  bytes: number;
  overflowed: boolean;
  finished: boolean;
  subscribers: Set<Subscriber>;
  retainTimer?: NodeJS.Timeout;
}

@Injectable()
export class AiChatStreamRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(AiChatStreamRegistryService.name);
  private readonly entries = new Map<string, Entry>(); // key: chatId

  /**
   * Register a fresh entry at the START of a run (before any frame), so a tab
   * that attaches in the begin->seed window finds an entry to wait on. If an
   * entry already exists for this chat (a previous, possibly still-live run whose
   * tee loop is draining), it is terminated MIRRORING the done-path (invariant 3)
   * so its subscribers are released and its retention timer is cleared; a late
   * `done` from that old tee then fires against the closed-over old reference and,
   * thanks to identity checks, never touches this new entry.
   */
  open(chatId: string, runId: string): void {
    const existing = this.entries.get(chatId);
    if (existing) {
      if (existing.retainTimer) {
        clearTimeout(existing.retainTimer);
        existing.retainTimer = undefined;
      }
      // Started subscribers get exactly one onEnd() and are removed; paused ones
      // are marked pendingEnd (their start() will end them). finished=true guards
      // any later done from the old tee loop from double-notifying.
      this.terminateSubscribers(existing);
    }
    this.entries.set(chatId, {
      runId,
      frames: [],
      bytes: 0,
      overflowed: false,
      finished: false,
      subscribers: new Set<Subscriber>(),
    });
  }

  /**
   * Tee a run's SSE frame stream into its entry (called from consumeSseStream).
   * No-op with a warning when there is no entry or the entry belongs to a
   * different run (invariant 1). The reader loop is fire-and-forget: the tee
   * branch outlives the client socket by design.
   */
  bind(
    chatId: string,
    runId: string,
    assistantMessageId: string | undefined,
    stream: ReadableStream<string>,
  ): void {
    const entry = this.entries.get(chatId);
    if (!entry || entry.runId !== runId) {
      // Invariant 1: only the matching run may mutate the entry.
      this.logger.warn(
        `bind: no matching run-stream entry for chat=${chatId} run=${runId}`,
      );
      return;
    }
    entry.assistantMessageId = assistantMessageId;
    const reader = stream.getReader();
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.ingestFrame(entry, value);
        }
        this.finalizeEntry(chatId, entry);
      } catch {
        // A read error is a terminal event too — release subscribers.
        this.finalizeEntry(chatId, entry);
      }
    };
    void pump();
  }

  /**
   * Terminate a run's entry from the OUTER catch of the stream method (a failure
   * before/while wiring the pipe, so `done` will never arrive). Identity-checked
   * on runId (invariant 1); the shared terminal path is idempotent.
   */
  abortEntry(chatId: string, runId: string): void {
    const entry = this.entries.get(chatId);
    if (!entry || entry.runId !== runId) return;
    this.finalizeEntry(chatId, entry);
  }

  /**
   * Attach to a run's stream. Async only for the phase-2 Redis seam — the body
   * runs synchronously so the replay snapshot and the subscriber registration
   * happen in ONE tick with no await between them (invariant 4): a frame ingested
   * concurrently cannot slip into the gap and be lost or duplicated.
   *
   * Returns null (-> the caller answers 204) when:
   *  - there is no entry, or it overflowed (replay is gone);
   *  - expect=live with an anchor that does not match this run's assistant id
   *    (invariant 6: a stripped tab must never replay a FOREIGN run's transcript);
   *  - the run finished and the caller did not expect a live tail.
   * A finished run with expect=live yields a replay-only attachment (no
   * subscriber registered). Otherwise a paused subscriber is registered and the
   * caller replays `replay`, then calls start() to drain and go live.
   */
  async attach(
    chatId: string,
    expectLive: boolean,
    anchor: string | undefined,
    cb: RunStreamCallbacks,
  ): Promise<RunStreamAttachment | null> {
    const entry = this.entries.get(chatId);
    if (!entry || entry.overflowed) return null;
    // Invariant 6: cross-run replay is forbidden. Before bind, assistantMessageId
    // is undefined and mismatches any anchor -> 204 -> client restore+poll path.
    if (expectLive && anchor && entry.assistantMessageId !== anchor) return null;
    if (entry.finished && !expectLive) return null;
    if (entry.finished && expectLive) {
      // Replay-only: the run is done, no subscriber is registered.
      return {
        replay: entry.frames.slice(),
        finished: true,
        start: () => undefined,
        unsubscribe: () => undefined,
      };
    }

    const sub: Subscriber = {
      onFrame: cb.onFrame,
      onEnd: cb.onEnd,
      started: false,
      pending: [],
      pendingBytes: 0,
      overflowed: false,
      pendingEnd: false,
    };
    entry.subscribers.add(sub);
    // Snapshot in the SAME synchronous block as the registration (invariant 4).
    const replay = entry.frames.slice();
    // CONTRACT: the caller MUST call start() in the SAME tick as this attach()
    // returns — no await between them. While a subscriber is paused, every frame
    // is buffered in sub.pending; a delayed start() lets a whole run accumulate
    // there. The pendingBytes cap (see ingestFrame) is the structural backstop if
    // that contract is ever broken (e.g. the phase-2 Redis await seam).
    return {
      replay,
      finished: false,
      start: () => {
        if (sub.overflowed) {
          // The pending buffer overflowed while paused: end the stream instead of
          // replaying a partial (a 204-equivalent post-attach degrade).
          try {
            sub.onEnd();
          } catch {
            // The socket is gone; nothing to end.
          }
          entry.subscribers.delete(sub);
          return;
        }
        // Deliver frames buffered while paused, in order, then go live.
        for (const frame of sub.pending) {
          try {
            sub.onFrame(frame);
          } catch {
            entry.subscribers.delete(sub);
            return;
          }
        }
        sub.pending = [];
        sub.started = true;
        if (sub.pendingEnd) {
          try {
            sub.onEnd();
          } catch {
            // The socket is gone; nothing to end.
          }
          entry.subscribers.delete(sub);
        }
      },
      unsubscribe: () => {
        entry.subscribers.delete(sub);
      },
    };
  }

  onModuleDestroy(): void {
    for (const entry of this.entries.values()) {
      if (entry.retainTimer) clearTimeout(entry.retainTimer);
    }
    this.entries.clear();
  }

  /** Buffer + fan-out a single frame. See invariant/overflow semantics inline. */
  private ingestFrame(entry: Entry, frame: string): void {
    entry.bytes += Buffer.byteLength(frame);
    if (!entry.overflowed) {
      entry.frames.push(frame);
      if (entry.bytes > RUN_STREAM_MAX_BUFFER_BYTES) {
        // The crossing frame was already counted AND (below) fanned out; only the
        // replay buffer is dropped. After overflow no more frames are buffered,
        // but live fan-out continues.
        entry.overflowed = true;
        entry.frames = [];
        this.logger.warn(
          `run-stream buffer overflow for run=${entry.runId}; ` +
            `late attach will 204 until the run ends`,
        );
      }
    }
    for (const sub of entry.subscribers) {
      if (sub.started) {
        try {
          sub.onFrame(frame);
        } catch {
          entry.subscribers.delete(sub);
        }
      } else {
        sub.pending.push(frame);
        sub.pendingBytes += Buffer.byteLength(frame);
        if (sub.pendingBytes > SUBSCRIBER_MAX_BUFFERED_BYTES) {
          // The paused subscriber's buffer overflowed — only possible if start()
          // was delayed past the same-tick contract (the phase-2 await seam).
          // Drop it rather than buffer the whole run; on start() it degrades to an
          // immediate end (a 204-equivalent) instead of replaying a partial.
          sub.overflowed = true;
          sub.pending = [];
          entry.subscribers.delete(sub);
        }
      }
    }
  }

  /**
   * Shared terminal path for done / read-error / external-abort. Idempotent: a
   * second call (already finished) is a no-op, so an open()-replaced or
   * abort-then-done entry is never double-armed or double-ended.
   */
  private finalizeEntry(chatId: string, entry: Entry): void {
    if (entry.finished) return;
    this.terminateSubscribers(entry);
    const timer = setTimeout(() => {
      // Invariant 2: only delete OUR entry (a replacement may already own the key).
      if (this.entries.get(chatId) === entry) this.entries.delete(chatId);
    }, RUN_STREAM_RETAIN_FINISHED_MS);
    timer.unref?.();
    entry.retainTimer = timer;
  }

  /**
   * Mark the entry finished and release its subscribers, mirroring the done-path:
   * started subscribers get exactly one onEnd() and are removed; paused ones are
   * flagged pendingEnd so their start() ends them. Deleting the current element
   * during Set iteration is safe.
   */
  private terminateSubscribers(entry: Entry): void {
    entry.finished = true;
    for (const sub of entry.subscribers) {
      if (sub.started) {
        try {
          sub.onEnd();
        } catch {
          // The socket is gone; nothing to end.
        }
        entry.subscribers.delete(sub);
      } else {
        sub.pendingEnd = true;
      }
    }
  }
}
