import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { sql } from 'kysely';
import {
  type Settings,
  readExisting,
  computePullActions,
  applyPullActions,
  runPush,
} from '@docmost/git-sync';
import { EnvironmentService } from '../../environment/environment.service';
import { GitmostDataSourceService } from './gitmost-datasource.service';
import { VaultRegistryService } from './vault-registry.service';
import {
  GIT_SYNC_LOCK_PREFIX,
  GIT_SYNC_LOCK_TTL_MS,
} from '../git-sync.constants';

/** A space the poll loop should reconcile: its id + the workspace it lives in. */
interface EnabledSpace {
  spaceId: string;
  workspaceId: string;
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
 * The git-sync control plane (plan §9/§10/§11). Drives the vendored engine in
 * process: under a Redis leader lock (single-writer across replicas) plus an
 * in-process per-space mutex (no overlapping cycles on one instance), it runs a
 * PULL (Docmost -> vault) then a PUSH (vault -> Docmost) for a space.
 *
 * Enumeration of enabled spaces (plan §10): STRICT opt-in. Only spaces whose
 * per-space flag `space.settings.gitSync.enabled === true` (written by the Phase-C
 * UI) are reconciled. There is intentionally NO all-spaces fallback: when no space
 * carries the flag, git-sync does NOTHING (an empty list) — flagging every space
 * the moment GIT_SYNC_ENABLED flips on is a safety hazard (it could mass-sync large
 * spaces). The whole loop is still gated on the GIT_SYNC_ENABLED master switch
 * first; per-space opt-in is now REQUIRED on top of it.
 */
@Injectable()
export class GitSyncOrchestrator {
  private readonly logger = new Logger(GitSyncOrchestrator.name);
  private readonly redis: Redis;
  /** Unique per process instance — the leader-lock value (CAS on release). */
  private readonly instanceId = randomUUID();
  /** In-process per-space mutex: spaceIds with a cycle currently running. */
  private readonly running = new Set<string>();

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly dataSource: GitmostDataSourceService,
    private readonly vaultRegistry: VaultRegistryService,
    redisService: RedisService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {
    this.redis = redisService.getOrThrow();
  }

  // --- Redis leader lock (plan §9) -----------------------------------------

  /**
   * Acquire per-space leadership: `SET <key> <instanceId> PX <ttl> NX` returns
   * 'OK' only when the key did not exist. Any other reply means another replica
   * holds it.
   */
  private async acquire(spaceId: string): Promise<boolean> {
    const ok = await this.redis.set(
      GIT_SYNC_LOCK_PREFIX + spaceId,
      this.instanceId,
      'PX',
      GIT_SYNC_LOCK_TTL_MS,
      'NX',
    );
    return ok === 'OK';
  }

  /**
   * Release the lock with a CAS Lua so we only delete it when WE still hold it
   * (the value matches our instanceId) — never another replica's lock that took
   * over after our TTL expired.
   */
  private async release(spaceId: string): Promise<void> {
    const lua =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
    try {
      await this.redis.eval(lua, 1, GIT_SYNC_LOCK_PREFIX + spaceId, this.instanceId);
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to release lock for space ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // --- enabled-space enumeration (plan §10) --------------------------------

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

  // --- one sync cycle for a space (plan §11) -------------------------------

  /**
   * Build the engine `Settings` for a space. The engine's REST-era fields
   * (docmostApiUrl/email/password) are unused on the native path — the
   * datasource writes in-process — so they are placeholders; only `vaultPath`,
   * `gitRemote`, and the tunables are load-bearing.
   */
  private buildSettings(spaceId: string): Settings {
    const remoteTemplate = this.environmentService.getGitSyncRemoteTemplate();
    const gitRemote = remoteTemplate
      ? remoteTemplate.replace(/\{spaceId\}/g, spaceId)
      : undefined;
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

    // In-process mutex: never run two overlapping cycles for the same space on
    // this instance (the Redis lock guards cross-instance, this guards in-proc).
    if (this.running.has(spaceId)) {
      return { spaceId, ran: false, skipped: 'in-progress' };
    }

    // Redis leader lock: only the holder runs the cycle (plan §9).
    if (!(await this.acquire(spaceId))) {
      return { spaceId, ran: false, skipped: 'lock-held' };
    }

    this.running.add(spaceId);
    try {
      return await this.driveCycle(spaceId, workspaceId, serviceUserId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`git-sync: cycle failed for space ${spaceId}: ${message}`);
      return { spaceId, ran: false, error: message };
    } finally {
      this.running.delete(spaceId);
      await this.release(spaceId);
    }
  }

  /**
   * The actual engine wiring (plan §11). Mirrors the engine's own `main`:
   *   PULL  — readExisting -> computePullActions -> applyPullActions,
   *   PUSH  — runPush (dry-run disabled: a real apply).
   * The dependency-object shapes match pull.ts/push.ts exactly (see comments).
   */
  private async driveCycle(
    spaceId: string,
    workspaceId: string,
    serviceUserId: string,
  ): Promise<GitSyncRunStatus> {
    const settings = this.buildSettings(spaceId);
    const vault = await this.vaultRegistry.getVault(spaceId);
    const vaultRoot = settings.vaultPath;
    const client = this.dataSource.bind({ workspaceId, userId: serviceUserId });

    // Engine state store is git: make sure the repo + branches exist before any
    // tracked-file listing or diff (the engine's pull/push assume an inited repo).
    await vault.assertGitAvailable();
    await vault.ensureRepo();

    // Refuse to run on top of an unresolved merge (SPEC §9 / plan §11.2): a prior
    // conflicting pull leaves the vault mid-merge; the next checkout would fail.
    if (await vault.isMergeInProgress()) {
      this.logger.warn(
        `git-sync[${spaceId}]: vault has an unresolved merge — resolve it (or ` +
          `'git merge --abort') and re-run (SPEC §9); skipping cycle.`,
      );
      return { spaceId, ran: false, skipped: 'merge-in-progress' };
    }

    await vault.ensureBranch('docmost', 'main');
    // CRITICAL: pull writes happen on the `docmost` branch — applyPullActions
    // commits there, then checks out `main` and merges docmost -> main. We MUST be
    // on `docmost` BEFORE applying (mirrors the engine's own pull main()), else the
    // Docmost content is written straight onto `main`, clobbering local file edits
    // before push can diff them.
    await vault.checkout('docmost');

    // --- PULL (plan §11.1/§11.2) --------------------------------------------
    // readExisting deps (ReadExistingDeps): list tracked *.md + read by relPath.
    const existing = await readExisting({
      listTracked: () => vault.listTrackedFiles('*.md'),
      readFile: (relPath) => readFile(`${vaultRoot}/${relPath}`, 'utf8'),
    });

    const tree = await client.listSpaceTree(spaceId);
    const pullActions = computePullActions({
      pages: tree.pages,
      treeComplete: true,
      existing,
    });

    // applyPullActions deps (ApplyPullActionsDeps): the read-side client subset,
    // the vault git subset, and ABSOLUTE-path fs ops (mkdir/writeFile/rm).
    const pullResult = await applyPullActions(
      {
        client,
        git: vault,
        writeFile: (absPath, text) => writeFile(absPath, text, 'utf8'),
        mkdir: (absDir) => mkdir(absDir, { recursive: true }).then(() => undefined),
        rm: (absPath) => rm(absPath, { force: true }),
      },
      pullActions,
      vaultRoot,
    );

    // --- PUSH (plan §11.3) --------------------------------------------------
    // runPush deps (PushDeps): settings, the full vault git object (method `this`
    // binding must be preserved — pass the object, not bound method refs), a
    // makeClient factory returning the push client subset, vault-relative fs
    // read/write, and a logger. dryRun:false performs the real Docmost writes.
    const pushDeps = {
      settings,
      git: vault,
      makeClient: () => client,
      readFile: (relPath: string) => readFile(`${vaultRoot}/${relPath}`, 'utf8'),
      writeFile: (relPath: string, text: string) =>
        writeFile(`${vaultRoot}/${relPath}`, text, 'utf8'),
      log: (line: string) => this.logger.log(`git-sync[${spaceId}] ${line}`),
    };

    // DEFENSE-IN-DEPTH delete cap (plan §11.3 step 6). A non-convergent vault
    // (e.g. empty/duplicate titles -> colliding paths) can compute PHANTOM
    // absence-deletions that slip under the engine's mass-delete FRACTION guard
    // and soft-delete real pages. So plan the push as a DRY-RUN FIRST to read the
    // delete count, and if it exceeds GIT_SYNC_MAX_DELETES_PER_CYCLE, run the real
    // apply with a client whose deletePage is NEUTRALIZED — creates/updates/
    // moves/renames still apply, deletions are skipped this cycle. Never throws.
    const maxDeletes = this.environmentService.getGitSyncMaxDeletesPerCycle();
    let suppressDeletes = false;
    try {
      const dry = await runPush(pushDeps, { dryRun: true });
      const plannedDeletes = dry.planned?.deletes ?? 0;
      if (plannedDeletes > maxDeletes) {
        suppressDeletes = true;
        this.logger.warn(
          `git-sync[${spaceId}]: push delete count ${plannedDeletes} exceeds ` +
            `GIT_SYNC_MAX_DELETES_PER_CYCLE=${maxDeletes}; skipping deletions this ` +
            `cycle (possible non-convergence / collision). Investigate vault layout.`,
        );
      }
    } catch (err) {
      // A failed dry-run plan must not block the apply, but we cannot trust a
      // delete count we never got — fail SAFE by suppressing deletes this cycle.
      suppressDeletes = true;
      this.logger.warn(
        `git-sync[${spaceId}]: push dry-run planning failed (${
          err instanceof Error ? err.message : String(err)
        }); skipping deletions this cycle as a precaution.`,
      );
    }

    // When over the cap, neutralize deletes by wrapping the client's deletePage
    // into a no-op (every other op is forwarded). The dry-run already committed
    // the working tree to `main`, so the apply re-diffs and converges normally.
    const applyClient = suppressDeletes
      ? { ...client, deletePage: async () => undefined }
      : client;

    const pushResult = await runPush(
      { ...pushDeps, makeClient: () => applyClient },
      { dryRun: false },
    );

    return {
      spaceId,
      ran: true,
      pull: {
        written: pullResult.written,
        deleted: pullResult.deleted,
        conflict: pullResult.merge.conflict,
      },
      push: {
        mode: pushResult.mode,
        failures: pushResult.failures?.length ?? 0,
      },
    };
  }

  // --- poll-safety interval (plan §10) -------------------------------------

  /**
   * Poll-safety loop: catches events missed by the listener and reconciles after
   * downtime. Gated on GIT_SYNC_ENABLED. The interval is a fixed value because
   * `@Interval` cannot read config at class-eval time — the body short-circuits
   * when disabled. Each enabled space runs under its own lock (overlaps skipped).
   *
   * ScheduleModule: registered ONCE globally by TelemetryModule
   * (ScheduleModule.forRoot()); GitSyncModule imports the plain ScheduleModule so
   * @Interval is discovered without a duplicate forRoot (plan §6 note).
   */
  @Interval('git-sync-poll', 15000)
  async poll(): Promise<void> {
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
