import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AiChatRunRepo } from '@docmost/db/repos/ai-chat/ai-chat-run.repo';
import { AiChatRun } from '@docmost/db/types/entity.types';
import { isUniqueViolation, violatedConstraint } from '@docmost/db/utils';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/** Name of the partial unique index enforcing "one active run per chat" (see the
 *  ai_chat_runs migration). A 23505 on THIS constraint is the race-safe signal
 *  that a concurrent turn already owns the chat — distinct from any other unique
 *  collision, which must NOT be silently treated as "already active". */
export const ONE_ACTIVE_RUN_PER_CHAT_INDEX = 'ai_chat_runs_one_active_per_chat';

/**
 * Thrown by {@link AiChatRunService.beginRun} when the run-row INSERT loses the
 * race for a chat's single active slot (the partial unique index rejects it with
 * a 23505). This is the AUTHORITATIVE concurrency gate: the controller's cheap
 * pre-check is only a fast-path, and a request that slips past it must NOT run
 * untracked. The caller (AiChatService.stream) translates this into a 409 and
 * aborts the turn BEFORE any AI/provider call.
 */
export class RunAlreadyActiveError extends Error {
  constructor(public readonly chatId: string) {
    super(`An agent run is already in progress for chat ${chatId}`);
    this.name = 'RunAlreadyActiveError';
  }
}

/**
 * The terminal status of a TURN (the #183 assistant-row lifecycle) maps onto the
 * terminal status of a RUN (#184). A turn that completed -> the run succeeded; a
 * turn that errored -> the run failed; a turn aborted (explicit user stop) -> the
 * run aborted. Pure + unit-testable.
 */
export type TurnTerminalStatus = 'completed' | 'error' | 'aborted';
export type RunTerminalStatus = 'succeeded' | 'failed' | 'aborted';

export function mapTurnStatusToRun(
  status: TurnTerminalStatus,
): RunTerminalStatus {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'error':
      return 'failed';
    case 'aborted':
      return 'aborted';
  }
}

/** An in-flight run held in process memory: its AbortController is the ONLY thing
 *  that can stop the turn (an explicit user stop), independent of the browser
 *  socket. A mere disconnect never touches it, so the run keeps going. */
interface ActiveRun {
  controller: AbortController;
  chatId: string;
  workspaceId: string;
}

/** The live handle the streaming path drives a run through (returned by
 *  {@link AiChatRunService.beginRun}). The `signal` governs the agent loop's
 *  abort — wired to the run, NOT to the HTTP socket. */
export interface RunHandle {
  runId: string;
  signal: AbortSignal;
}

/**
 * AiChatRunService (#184 phase 1) — owns the agent RUN as a first-class,
 * server-side lifecycle object detached from the HTTP request / browser window.
 *
 * Responsibilities:
 *  - create a run row when a turn starts (inserted directly as 'running'; the
 *    'pending' status is only the column default + a reserved value, never
 *    written by code in phase 1) and register an in-memory AbortController for it
 *    (the explicit-stop lever);
 *  - finalize the run row (succeeded / failed / aborted) and unregister it;
 *  - service an EXPLICIT user stop (`requestStop`) — the ONLY thing that aborts a
 *    run; a browser disconnect deliberately does NOT;
 *  - crash-recovery sweep of dangling runs on startup.
 *
 * The agent loop itself still runs in AiChatService.stream (reusing #183's
 * step-granular durable write path, `consumeStream` already drains it independent
 * of the socket); this service only wraps it in a durable lifecycle and an
 * abort handle that outlives the subscriber.
 */
@Injectable()
export class AiChatRunService implements OnModuleInit {
  private readonly logger = new Logger(AiChatRunService.name);

  // runId -> ActiveRun. Process-local on purpose (phase 1 is single-process /
  // in-memory transport; a cross-process BullMQ runner + Redis stop-signal is
  // deferred to phase 2). A stop for a runId not in this map (e.g. after a
  // restart) still records `stop_requested_at` on the row.
  private readonly active = new Map<string, ActiveRun>();

  // runIds whose TERMINAL row write has SUCCEEDED — the idempotency once-gate
  // (F6). A finalize must short-circuit only AFTER the terminal write has landed,
  // NOT merely after the in-memory entry was dropped: a transient UPDATE failure
  // has to stay retryable, so "already settled" means "row already terminal", not
  // "entry already gone". Grows by one short UUID per finished run over process
  // uptime — negligible in phase 1's single process.
  private readonly settled = new Set<string>();

  // Bounded retry for the terminal write (F6): a single PK UPDATE can fail
  // transiently under many fire-and-forget writes (pool exhaustion, deadlock, a
  // brief connection blip). Riding out that blip in-place matters because the
  // dominant success path (streamText onFinish) settles exactly ONCE — if that
  // write is dropped and never retried, the row is stranded 'running' and the
  // one-active-run gate 409s every future turn in the chat until a restart (no
  // periodic sweep in phase 1).
  private static readonly FINALIZE_MAX_ATTEMPTS = 3;
  private static readonly FINALIZE_RETRY_BASE_MS = 50;

  constructor(
    private readonly runRepo: AiChatRunRepo,
    private readonly environment: EnvironmentService,
  ) {}

  /**
   * Crash-recovery sweep on server start: settle EVERY run still left
   * pending/running to 'aborted' (F1 / DECISION C). The boot sweep is
   * UNCONDITIONAL — no staleness window — because phase 1 is single-process: on a
   * fresh boot any pending|running run is definitionally hung (no live runner owns
   * it), so even a fast restart (deploy/OOM within minutes of the last step) can
   * no longer leave a run stuck 'running' forever (which would make the
   * one-active-run gate 409 every future turn in that chat). The staleness window
   * is reintroduced only for the phase-2 multi-instance timer sweep, where a
   * booting replica must not abort a run another replica is actively executing.
   * Best-effort — a sweep failure is logged but MUST NOT block startup (mirrors
   * AiChatService.onModuleInit for #183).
   */
  async onModuleInit(): Promise<void> {
    this.warnIfMultiInstance();
    try {
      // No `staleMs`: unconditional boot sweep (F1). See AiChatRunRepo.sweepRunning.
      const swept = await this.runRepo.sweepRunning();
      if (swept > 0) {
        this.logger.log(
          `Startup sweep: marked ${swept} dangling agent run(s) as 'aborted'.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Startup sweep of dangling runs failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * F2 (DECISION A): autonomous runs are SINGLE-INSTANCE-ONLY in phase 1. An
   * explicit Stop, and the in-memory AbortController that backs it, are
   * process-local: a Stop only aborts the live turn if it lands on the SAME
   * replica that owns the run (it still stamps `stop_requested_at` cross-instance,
   * but nothing reads that flag during an active run yet). Cross-instance pub/sub
   * stop is phase 2. So if the deployment is horizontally scaled, warn loudly at
   * startup that a Stop may not reach a run executing on another replica.
   *
   * DETECTION: this codebase always wires the socket.io Redis adapter (REDIS_URL
   * is mandatory), so the adapter alone is NOT a horizontal-scaling signal. The
   * authoritative signal the codebase has is `CLOUD=true` (EnvironmentService
   * .isCloud()), the Docmost-cloud multi-replica deployment. We warn whenever that
   * is set, because any workspace could enable settings.ai.autonomousRuns. A
   * self-hosted operator running multiple replicas behind a load balancer is also
   * multi-instance; the deploy docs (.env.example / AGENTS.md) spell out the
   * single-instance constraint for that case.
   */
  private warnIfMultiInstance(): void {
    if (this.environment.isCloud()) {
      this.logger.warn(
        'Autonomous agent runs (settings.ai.autonomousRuns) are SINGLE-INSTANCE-ONLY ' +
          'in phase 1: a horizontally-scaled deployment was detected (CLOUD=true). ' +
          'An explicit Stop only aborts a run executing on the same replica that owns ' +
          'it (cross-instance Stop is not yet reliable — phase 2). Run a single ' +
          'instance if you enable autonomousRuns, or keep the flag off.',
      );
    }
  }

  /**
   * Start a run for a turn: insert the run row (status 'running', startedAt now),
   * register a fresh AbortController for it, and return a {@link RunHandle} whose
   * `signal` the agent loop uses. The DB partial unique index guarantees at most
   * one active run per chat — a second concurrent start on the same chat REJECTS
   * at the insert (a 23505 on {@link ONE_ACTIVE_RUN_PER_CHAT_INDEX}). That
   * rejection is the AUTHORITATIVE race gate: it is surfaced as a distinct
   * {@link RunAlreadyActiveError} (NOT swallowed), so the caller turns it into a
   * 409 and never streams an untracked turn. The controller is registered AFTER a
   * successful insert so a rejected start leaks nothing.
   */
  async beginRun(args: {
    chatId: string;
    workspaceId: string;
    userId: string;
    trigger?: string;
  }): Promise<RunHandle> {
    let run: AiChatRun;
    try {
      run = await this.runRepo.insert({
        chatId: args.chatId,
        workspaceId: args.workspaceId,
        createdBy: args.userId,
        trigger: args.trigger ?? 'user',
        status: 'running',
        startedAt: new Date(),
      });
    } catch (err) {
      // The race backstop: a concurrent turn already holds this chat's single
      // active slot, so the partial unique index rejected our insert. Surface a
      // distinct signal — the caller MUST reject this turn (409), not run it
      // untracked. Any OTHER error propagates unchanged.
      if (
        isUniqueViolation(err) &&
        violatedConstraint(err) === ONE_ACTIVE_RUN_PER_CHAT_INDEX
      ) {
        throw new RunAlreadyActiveError(args.chatId);
      }
      throw err;
    }
    const controller = new AbortController();
    this.active.set(run.id, {
      controller,
      chatId: args.chatId,
      workspaceId: args.workspaceId,
    });
    return { runId: run.id, signal: controller.signal };
  }

  /** Link the assistant message (the #183 projection) to its run. Best-effort. */
  async linkAssistantMessage(
    runId: string,
    workspaceId: string,
    assistantMessageId: string,
  ): Promise<void> {
    try {
      await this.runRepo.update(runId, workspaceId, { assistantMessageId });
    } catch (err) {
      this.logger.warn(
        `Failed to link assistant message to run ${runId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /** Persist progress: bump the run's finished-step count. Best-effort (never
   *  blocks or breaks the stream). */
  async recordStep(
    runId: string,
    workspaceId: string,
    stepCount: number,
  ): Promise<void> {
    try {
      await this.runRepo.update(runId, workspaceId, { stepCount });
    } catch (err) {
      this.logger.warn(
        `Failed to record step for run ${runId}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * Finalize a run to its terminal status (succeeded / failed / aborted),
   * stamping finishedAt + any error. Best-effort, but ROBUST against a transient
   * terminal-write failure (F6) AND atomically safe against a concurrent settle.
   *
   * ATOMIC ONCE-CLAIM (the gate must close in ONE synchronous tick): two
   * finalizeRun calls for the SAME run can race — the documented real path is
   * AiChatService.stream's safety-net catch settling the turn to 'error' while a
   * streamText terminal callback (onFinish/onAbort/onError) ALSO settles it. The
   * `settled.has` check alone is NOT a gate: it is read BEFORE the awaited UPDATE,
   * so two callers can both see `false` and both write the row (last-write-wins
   * clobbers the real terminal status, and the bounded retry only widens that
   * window). The claim therefore happens via `active.delete`, a SYNCHRONOUS
   * check-and-clear with NO await between the gate and the entry removal: the
   * second concurrent caller finds the entry already gone and returns in the same
   * tick, before any UPDATE. The transition "nobody is finalizing" -> "I am
   * finalizing" is thus a single atomic step.
   *
   * ORDER MATTERS (F6): once we own the claim, the terminal UPDATE happens FIRST;
   * only once it SUCCEEDS do we record the run as settled. If the UPDATE fails on
   * every bounded attempt we RESTORE the in-memory entry, leave the run UNsettled,
   * and emit an ERROR signal that the row is left non-terminal 'running' (which
   * would 409 every future turn in the chat until recovery). An in-process retry
   * by a LATER settle is only POSSIBLE, never guaranteed: it needs (a) the entry
   * to have been restored at the give-up path AND (b) a fresh settler to arrive
   * AFTER that restore. A concurrent settler that arrives DURING the retry window
   * — while the entry is deleted for backoff and not yet restored — is consumed at
   * the synchronous `active.delete` claim (it finds nothing to delete and returns
   * a no-op), so it does NOT become an in-process retrier. The NO-streamText path
   * (the turn threw before streamText was wired, so ONLY the safety-net ever
   * settles) likewise has no second in-process settler at all. The UNCONDITIONAL
   * backstop in every case is the boot sweep on the next restart (phase 1 has no
   * periodic in-process sweep); the retained entry is bounded (cleared on restart)
   * and harmless meanwhile.
   *
   * IDEMPOTENT on SUCCESS (#184 review): the terminal write happens AT MOST ONCE
   * per run. After a successful write the once-gate keys off {@link settled} (the
   * terminal row already written) so a settle arriving AFTER the entry was already
   * dropped-and-settled returns early; a settle racing the in-flight write is
   * stopped earlier still, by the `active.delete` claim. Either way a genuine
   * double-settle collapses to a single write and a late settle can never clobber
   * the real terminal status or double-write the row.
   */
  async finalizeRun(
    runId: string,
    workspaceId: string,
    turnStatus: TurnTerminalStatus,
    error?: string,
  ): Promise<void> {
    // ---- Atomic once-claim (synchronous; NO await before the gate closes) ----
    // Already terminally written -> idempotent no-op.
    if (this.settled.has(runId)) return;
    // Capture the entry BEFORE the delete so a total-failure path can restore it.
    const entry = this.active.get(runId);
    // SYNCHRONOUS check-and-clear: the FIRST caller deletes (claims) the entry;
    // any concurrent SECOND caller finds nothing to delete and returns HERE, in
    // the same tick, before any await — so it can never reach the UPDATE.
    if (!this.active.delete(runId)) return;

    let lastError: unknown;
    for (
      let attempt = 1;
      attempt <= AiChatRunService.FINALIZE_MAX_ATTEMPTS;
      attempt++
    ) {
      try {
        await this.runRepo.update(runId, workspaceId, {
          status: mapTurnStatusToRun(turnStatus),
          finishedAt: new Date(),
          error: error ?? null,
        });
        // Terminal write landed: arm the once-gate. The entry is already gone
        // (claimed above); we do NOT restore it. The slot is now free.
        this.settled.add(runId);
        return;
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `Failed to finalize run ${runId} (attempt ${attempt}/${
            AiChatRunService.FINALIZE_MAX_ATTEMPTS
          }): ${err instanceof Error ? err.message : 'unknown error'}`,
        );
        if (attempt < AiChatRunService.FINALIZE_MAX_ATTEMPTS) {
          await this.delay(AiChatRunService.FINALIZE_RETRY_BASE_MS * attempt);
        }
      }
    }
    // Every attempt failed: this is a give-up, materially worse than a per-attempt
    // blip — the row is left NON-TERMINAL ('running'), so emit ONE explicit,
    // greppable ERROR so an operator can tell "survived a blip" from "gave up, run
    // held in memory until recovery" (the last warn alone says only "attempt 3/3").
    this.logger.error(
      `Run ${runId} (chat ${entry?.chatId ?? 'unknown'}) left NON-TERMINAL ` +
        `('running'): terminal write failed after ${
          AiChatRunService.FINALIZE_MAX_ATTEMPTS
        } attempts; entry retained in memory, recovery deferred to next settle / ` +
        `boot sweep`,
      lastError,
    );
    // RESTORE the claimed entry (and leave the run UNsettled) so a LATER settle
    // that arrives AFTER this restore MAY retry the terminal write — but that
    // in-process retry is NOT guaranteed (a concurrent settler caught in the retry
    // window above is consumed at the `active.delete` claim, and the no-streamText
    // path has no second settler at all). The UNCONDITIONAL backstop in every case
    // is the boot sweep on the next restart; the restored entry is bounded and
    // cleared on restart.
    if (entry) this.active.set(runId, entry);
  }

  /** Small async backoff between terminal-write retries (F6). Isolated so it is
   *  trivial to stub/fake-time in tests. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Request an EXPLICIT stop of a run (the user pressed Stop). This is the ONLY
   * thing that aborts a run — distinct from a browser disconnect, which leaves
   * the run going. Aborts the in-process controller FIRST (the only thing that
   * actually stops the run, if this replica owns it), then makes a best-effort
   * attempt to stamp `stop_requested_at` — that audit write stamps only while the
   * row is active and may be skipped on a DB error or lost to the finalize race,
   * which is acceptable since the row still settles as 'aborted'. Returns true
   * when a stop took effect (row marked and/or controller aborted), false when
   * there was nothing active to stop.
   */
  async requestStop(runId: string, workspaceId: string): Promise<boolean> {
    const entry = this.active.get(runId);
    if (entry) {
      // Abort the live turn FIRST -> streamText onAbort fires -> the partial is
      // persisted (#183) and finalizeRun settles the row as 'aborted'. This is
      // the ONLY thing that aborts a run, so it MUST NOT be hostage to the audit
      // write below: a transient failure on `markStopRequested` (pool exhaustion,
      // deadlock, dropped connection) must never leave the run executing despite
      // an explicit Stop. At worst only the `stop_requested_at` timestamp is lost.
      entry.controller.abort();
    }
    // Record `stop_requested_at` (best-effort). A transient DB failure here is
    // logged and treated as `marked = false`; the abort above already took
    // effect, so we never rethrow and skip stopping the run. Note: because
    // markStopRequested only stamps while the row is active, aborting first means
    // even a healthy write can lose the race against the resulting finalize and
    // skip the stamp — acceptable, as the row still settles as 'aborted' and only
    // this audit timestamp may be lost.
    let marked: unknown;
    try {
      marked = await this.runRepo.markStopRequested(runId, workspaceId);
    } catch (err) {
      marked = undefined;
      this.logger.warn(
        `requestStop: markStopRequested failed for run ${runId} ` +
          `(stop_requested_at not recorded); abort already issued: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return Boolean(marked) || Boolean(entry);
  }

  /** Latest persisted run for a chat — the reconnect target (an in-flight or
   *  finished run). Pure read-through to the repo. */
  getLatestForChat(
    chatId: string,
    workspaceId: string,
  ): Promise<AiChatRun | undefined> {
    return this.runRepo.findLatestByChat(chatId, workspaceId);
  }

  /** Fetch a run by id (workspace-scoped). Used to resolve + ownership-check an
   *  explicit stop targeting a runId. */
  getRun(runId: string, workspaceId: string): Promise<AiChatRun | undefined> {
    return this.runRepo.findById(runId, workspaceId);
  }

  /** The active run on a chat, if any (used to reject a concurrent start with a
   *  clean 409 before committing to the stream). */
  getActiveForChat(
    chatId: string,
    workspaceId: string,
  ): Promise<AiChatRun | undefined> {
    return this.runRepo.findActiveByChat(chatId, workspaceId);
  }

  /** Test/diagnostic seam: whether this replica is holding a live controller for
   *  the run. */
  isLocallyActive(runId: string): boolean {
    return this.active.has(runId);
  }
}
