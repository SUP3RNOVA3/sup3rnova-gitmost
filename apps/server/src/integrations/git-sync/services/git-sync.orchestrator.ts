import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import type { Settings } from '@docmost/git-sync';
import { loadGitSync } from '../git-sync.loader';
import { EnvironmentService } from '../../environment/environment.service';
import { GitmostDataSourceService } from './gitmost-datasource.service';
import { VaultRegistryService } from './vault-registry.service';
import { SpaceLockService } from './space-lock.service';

/** A space the poll loop should reconcile: its id + the workspace it lives in. */
interface EnabledSpace {
  spaceId: string;
  workspaceId: string;
}

/**
 * Thrown by `ingestExternalPush` when the per-space lock cannot be acquired (a
 * poll cycle is mid-flight on this or another replica). The /git HTTP handler
 * maps it to a 503 so the git client retries rather than racing a cycle's
 * working-tree checkout/merge.
 */
export class GitSyncLockHeldError extends Error {
  constructor(public readonly spaceId: string) {
    super(`git-sync: space ${spaceId} is busy (lock held); retry the push`);
    this.name = 'GitSyncLockHeldError';
  }
}

/** Small status summary returned by `runOnce` (for the admin trigger + logs). */
export interface GitSyncRunStatus {
  spaceId: string;
  ran: boolean;
  /** Why the cycle did not run (lock held elsewhere, busy, disabled, error). */
  skipped?:
    | 'lock-held'
    | 'in-progress'
    | 'disabled'
    | 'no-service-user'
    | 'merge-in-progress';
  pull?: { written: number; deleted: number; conflict: boolean };
  push?: { mode: string; failures: number };
  error?: string;
}

/**
 * The git-sync control plane. Drives the vendored engine in
 * process: under a Redis leader lock (single-writer across replicas) plus an
 * in-process per-space mutex (no overlapping cycles on one instance), it runs a
 * PULL (Docmost -> vault) then a PUSH (vault -> Docmost) for a space.
 *
 * Enumeration of enabled spaces: STRICT opt-in. Only spaces whose
 * per-space flag `space.settings.gitSync.enabled === true` (written by the Phase-C
 * UI) are reconciled. There is intentionally NO all-spaces fallback: when no space
 * carries the flag, git-sync does NOTHING (an empty list) — flagging every space
 * the moment GIT_SYNC_ENABLED flips on is a safety hazard (it could mass-sync large
 * spaces). The whole loop is still gated on the GIT_SYNC_ENABLED master switch
 * first; per-space opt-in is now REQUIRED on top of it.
 */
@Injectable()
export class GitSyncOrchestrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GitSyncOrchestrator.name);
  /** The registered poll-interval name, or null when none is registered. */
  private pollIntervalName: string | null = null;

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly dataSource: GitmostDataSourceService,
    private readonly vaultRegistry: VaultRegistryService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly spaceLock: SpaceLockService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  // --- enabled-space enumeration --------------------------------

  /**
   * Enumerate the spaces the poll loop should reconcile. STRICT opt-in: ONLY
   * spaces carrying the Phase-C per-space flag (`settings->'gitSync'->>'enabled'
   * = 'true'`, written by the Phase-C UI) are returned. There is intentionally NO
   * fallback to "all live spaces" — when no space is flagged this returns an empty
   * list and git-sync does nothing (correct opt-in behavior). The GIT_SYNC_ENABLED
   * master switch gates whether the loop runs at all; this flag gates which spaces.
   */
  private async enabledSpaces(): Promise<EnabledSpace[]> {
    return this.db
      .selectFrom('spaces')
      .select(['id as spaceId', 'workspaceId'])
      .where('deletedAt', 'is', null)
      .where(sql<boolean>`settings->'gitSync'->>'enabled' = 'true'`)
      .execute();
  }

  // --- one sync cycle for a space -------------------------------

  /**
   * Build the engine `Settings` for a space. The engine's REST-era fields
   * (docmostApiUrl/email/password) are unused on the native path — the
   * datasource writes in-process — so they are placeholders; only `vaultPath`,
   * `gitRemote`, and the tunables are load-bearing.
   */
  private async buildSettings(spaceId: string): Promise<Settings> {
    const remoteTemplate = this.environmentService.getGitSyncRemoteTemplate();
    const gitRemote = remoteTemplate
      ? remoteTemplate.replace(/\{spaceId\}/g, spaceId)
      : undefined;
    // Per-space PUSH policy for still-conflicted page bodies (SPEC §9): read the
    // `gitSync.autoMergeConflicts` flag from the space's jsonb settings. STRICT
    // opt-in like `enabled` — anything other than the literal 'true' (absent, null,
    // 'false') resolves to the SAFE default (skip a conflicted page, do not push).
    const row = await this.db
      .selectFrom('spaces')
      .select(
        sql<boolean>`settings->'gitSync'->>'autoMergeConflicts' = 'true'`.as(
          'autoMergeConflicts',
        ),
      )
      .where('id', '=', spaceId)
      .executeTakeFirst();
    return {
      docmostApiUrl: 'http://native.local',
      docmostEmail: 'native@local',
      docmostPassword: 'native',
      docmostSpaceId: spaceId,
      vaultPath: this.vaultRegistry.vaultPath(spaceId),
      gitRemote,
      pollIntervalMs: this.environmentService.getGitSyncPollIntervalMs(),
      debounceMs: this.environmentService.getGitSyncDebounceMs(),
      logLevel: 'info',
      autoMergeConflicts: row?.autoMergeConflicts ?? false,
    };
  }

  /**
   * Run one full PULL + PUSH cycle for a space, under the Redis leader lock and
   * the in-process mutex. Never throws — per-space errors are caught, logged, and
   * returned in the status so a poll interval is never broken by one bad space.
   */
  async runOnce(
    spaceId: string,
    workspaceId: string,
  ): Promise<GitSyncRunStatus> {
    if (!this.environmentService.isGitSyncEnabled()) {
      return { spaceId, ran: false, skipped: 'disabled' };
    }
    const serviceUserId = this.environmentService.getGitSyncServiceUserId();
    if (!serviceUserId) {
      this.logger.error(
        'git-sync: GIT_SYNC_SERVICE_USER_ID is required when GIT_SYNC_ENABLED — skipping',
      );
      return { spaceId, ran: false, skipped: 'no-service-user' };
    }

    // Run the full cycle under the per-space lock. withSpaceLock owns the
    // in-process mutex (no overlapping cycles on this instance) AND the Redis
    // leader lock (single writer across replicas), and returns a skip sentinel
    // when it could not enter — surfaced here as the existing skipped:'in-progress'
    // / 'lock-held' status so runOnce's observable behavior is unchanged.
    try {
      const result = await this.spaceLock.withSpaceLock(spaceId, (signal) =>
        this.driveCycle(spaceId, workspaceId, serviceUserId, signal),
      );
      if ('skipped' in result && !('spaceId' in result)) {
        return { spaceId, ran: false, skipped: result.skipped };
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`git-sync: cycle failed for space ${spaceId}: ${message}`);
      return { spaceId, ran: false, error: message };
    }
  }

  /**
   * Ingest a push that arrived over smart-HTTP (the /git host). Under the SAME
   * per-space lock the poll cycle uses, it:
   *   1. runs `runReceivePack()` — the closure that spawns `git http-backend` for
   *      the receive-pack request and finishes streaming the HTTP response to the
   *      client. The client's push result is determined here.
   *   2. THEN — still holding the lock — runs the full Docmost cycle (the same
   *      `driveCycle` body `runOnce` uses) so the freshly received commits on
   *      `main` flow back into Docmost pages.
   *
   * If the cycle body in step 2 throws, it is LOGGED but NOT rethrown: the push
   * already succeeded and the commits are durable on `main`, so the poll-interval
   * backstop will reconcile them on the next tick. The receive-pack itself is the
   * load-bearing step.
   *
   * Lock contention: if the lock cannot be acquired (a poll cycle is mid-flight),
   * this throws a `GitSyncLockHeldError`. The HTTP handler converts that to a 503
   * so git surfaces a retryable error to the user (chosen over blocking the
   * request behind a potentially long cycle). The receive-pack is NOT run when
   * the lock is held — we never write to the working tree concurrently with a
   * cycle.
   */
  async ingestExternalPush(
    spaceId: string,
    workspaceId: string,
    runReceivePack: () => Promise<void>,
  ): Promise<void> {
    if (!this.environmentService.isGitSyncEnabled()) {
      // The HTTP gate already checks this, but be defensive: never run a cycle
      // when sync is globally off.
      throw new GitSyncLockHeldError(spaceId);
    }
    const serviceUserId = this.environmentService.getGitSyncServiceUserId();

    const result = await this.spaceLock.withSpaceLock(spaceId, async (signal) => {
      // 1) Stream the receive-pack to the client (durable commits land on main).
      await runReceivePack();

      // 2) Reconcile the new commits into Docmost. A service user is required to
      // attribute the writes; without one we cannot run the cycle — the commits
      // are still durable and the poll backstop will pick them up once configured.
      if (!serviceUserId) {
        this.logger.error(
          'git-sync: GIT_SYNC_SERVICE_USER_ID is required to ingest an external ' +
            'push — the push is durable on main; skipping the immediate cycle.',
        );
        return;
      }
      try {
        await this.driveCycle(spaceId, workspaceId, serviceUserId, signal);
      } catch (err) {
        // Do NOT rethrow: the push succeeded and the commits are durable on main;
        // the poll-interval backstop retries the cycle. Log for visibility.
        this.logger.error(
          `git-sync: post-push cycle failed for space ${spaceId} (push is ` +
            `durable; poll will retry): ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
      return;
    });

    // The lock was held (in-progress or another replica) — surface to the caller
    // so the HTTP handler can answer 503 and let git retry.
    if (typeof result === 'object' && result !== null && 'skipped' in result) {
      throw new GitSyncLockHeldError(spaceId);
    }
  }

  /**
   * Drive ONE reconcile cycle for a space. The PULL->PUSH branch choreography
   * lives in the engine's `runCycle` (so it can never drift from the engine it
   * ships with); the orchestrator owns only the lock (its caller) and the
   * gitmost-specific delete-cap POLICY, injected here as the `resolveApplyClient`
   * hook.
   */
  private async driveCycle(
    spaceId: string,
    workspaceId: string,
    serviceUserId: string,
    signal?: AbortSignal,
  ): Promise<GitSyncRunStatus> {
    const { runCycle } = await loadGitSync();
    const settings = await this.buildSettings(spaceId);
    const vault = await this.vaultRegistry.getVault(spaceId);
    const client = this.dataSource.bind({ workspaceId, userId: serviceUserId });
    const maxDeletes = this.environmentService.getGitSyncMaxDeletesPerCycle();

    const result = await runCycle({
      // Cooperative-abort signal from the per-space lock: if a heartbeat refresh
      // cannot confirm the lock, the cycle bails before its next destructive
      // write phase instead of writing blind after a possible lock loss.
      signal,
      spaceId,
      client,
      vault,
      settings,
      // ABSOLUTE-path fs primitives the engine cycle injects (it stays IO-free).
      fs: {
        readFile: (absPath) => readFile(absPath, 'utf8'),
        writeFile: (absPath, text) => writeFile(absPath, text, 'utf8'),
        mkdir: (absDir) => mkdir(absDir, { recursive: true }).then(() => undefined),
        rm: (absPath) => rm(absPath, { force: true }),
      },
      log: (line: string) => this.logger.log(`git-sync[${spaceId}] ${line}`),
      // DEFENSE-IN-DEPTH delete cap (gitmost-specific policy). A non-convergent
      // vault (e.g. empty/duplicate titles -> colliding paths) can compute
      // PHANTOM absence-deletions. When the push's planned delete count exceeds
      // GIT_SYNC_MAX_DELETES_PER_CYCLE (or planning failed -> Infinity), suppress
      // deletes by making deletePage THROW: the engine records each as a per-page
      // failure, which keeps `refs/docmost/last-pushed` from advancing past the
      // dropped-file commit, so the deletion is RETRIED next cycle rather than
      // silently dropped (a no-op that resolved would advance the ref and a pull
      // would then recreate the user's deleted files). See PR #119 review.
      resolveApplyClient: (plannedDeletes, c) => {
        if (plannedDeletes <= maxDeletes) return c;
        this.logger.warn(
          `git-sync[${spaceId}]: push delete count ${plannedDeletes} exceeds ` +
            `GIT_SYNC_MAX_DELETES_PER_CYCLE=${maxDeletes}; suppressing deletions ` +
            `this cycle (possible non-convergence / collision). Investigate vault ` +
            `layout.`,
        );
        return {
          ...c,
          deletePage: async () => {
            throw new Error(
              'git-sync: delete suppressed this cycle ' +
                '(over GIT_SYNC_MAX_DELETES_PER_CYCLE) — refs intentionally held ' +
                'so the deletion is retried, not dropped',
            );
          },
        };
      },
    });

    return { spaceId, ...result };
  }

  // --- poll-safety interval -------------------------------------

  /** Registered interval name (shared by registration + teardown). */
  private static readonly POLL_INTERVAL_NAME = 'git-sync-poll';

  /**
   * Register the poll-safety interval DYNAMICALLY so it honors the configured
   * GIT_SYNC_POLL_INTERVAL_MS (a static `@Interval` decorator could only hardcode
   * a value at class-eval time, before config is readable — diverging from what
   * `/status` reports). When git-sync is disabled we register nothing.
   *
   * ScheduleModule: forRoot() is registered ONCE globally by TelemetryModule;
   * GitSyncModule imports the plain ScheduleModule so SchedulerRegistry is
   * injectable without a duplicate forRoot.
   */
  onModuleInit(): void {
    if (!this.environmentService.isGitSyncEnabled()) return;

    const ms = this.environmentService.getGitSyncPollIntervalMs();
    const handle = setInterval(() => {
      void this.pollTick();
    }, ms);
    // Do not keep the event loop alive solely for the poll timer.
    handle.unref?.();
    this.schedulerRegistry.addInterval(
      GitSyncOrchestrator.POLL_INTERVAL_NAME,
      handle,
    );
    this.pollIntervalName = GitSyncOrchestrator.POLL_INTERVAL_NAME;
    this.logger.log(`git-sync: poll interval registered (${ms}ms).`);
  }

  /** Tear down the dynamic interval on shutdown (guard against double-delete). */
  onModuleDestroy(): void {
    if (!this.pollIntervalName) return;
    try {
      // deleteInterval clears the timer and removes it from the registry.
      this.schedulerRegistry.deleteInterval(this.pollIntervalName);
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to delete poll interval: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.pollIntervalName = null;
    }
  }

  /**
   * One poll tick: catches events missed by the listener and reconciles after
   * downtime. Gated on GIT_SYNC_ENABLED (defensive — the interval is only
   * registered when enabled). Each enabled space runs under its own lock
   * (overlaps skipped). Never throws (runOnce swallows per-space errors).
   */
  private async pollTick(): Promise<void> {
    if (!this.environmentService.isGitSyncEnabled()) return;
    let spaces: EnabledSpace[];
    try {
      spaces = await this.enabledSpaces();
    } catch (err) {
      this.logger.error(
        `git-sync: failed to enumerate enabled spaces: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    for (const { spaceId, workspaceId } of spaces) {
      // runOnce never throws; a per-space error is logged and returned in status.
      await this.runOnce(spaceId, workspaceId);
    }
  }
}
