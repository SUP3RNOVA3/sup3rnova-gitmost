import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  GIT_SYNC_LOCK_PREFIX,
  GIT_SYNC_LOCK_TTL_MS,
} from '../git-sync.constants';

/**
 * The per-space lock used by the git-sync control plane: an in-process per-space
 * mutex (no overlapping cycles on one instance) PLUS a Redis leader lock
 * (single writer across replicas). Extracted from `GitSyncOrchestrator` so the
 * locking primitive is a single reusable, independently testable unit
 * (PR #119 refactor #2).
 */
@Injectable()
export class SpaceLockService {
  private readonly logger = new Logger(SpaceLockService.name);
  private readonly redis: Redis;
  /** Unique per process instance — the leader-lock value (CAS on release). */
  private readonly instanceId = randomUUID();
  /** In-process per-space mutex: spaceIds with a cycle currently running. */
  private readonly running = new Set<string>();
  /**
   * Process-wide single-writer guard: spaceId -> instanceId of the live holder.
   * Unlike `running` (scoped to ONE service instance), this is shared by every
   * SpaceLockService in the process, so even if the Redis lock key lapses
   * (swallowed heartbeat / TTL expiry) a SECOND holder in the same process
   * cannot start a concurrent cycle for the same space — it is rejected
   * 'lock-held'. The cross-PROCESS race is handled by the Redis lock plus
   * abort-on-refresh-failure (and, as a follow-up, fencing tokens).
   */
  private static readonly liveLocks = new Map<string, string>();

  constructor(redisService: RedisService) {
    this.redis = redisService.getOrThrow();
  }

  // --- Redis leader lock -----------------------------------------

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

  /**
   * CAS-guarded TTL refresh: extend the lock's TTL ONLY while WE still own it
   * (the stored value matches our instanceId) — never extend another replica's
   * lock that took over after our TTL expired. Used by the heartbeat in
   * `withSpaceLock` so a long-running push (client-controlled receive-pack + the
   * Docmost cycle) cannot outlive the lock and let a concurrent cycle race the
   * working tree. Never throws (a thrown timer callback would crash the process),
   * but a refresh it cannot CONFIRM is treated as a LOST lock: it aborts the
   * supplied controller so the in-flight protected fn stops instead of writing
   * blind while another replica may already have taken over the lock.
   */
  private async refreshLock(
    spaceId: string,
    controller?: AbortController,
  ): Promise<void> {
    const lua =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
    try {
      const res = await this.redis.eval(
        lua,
        1,
        GIT_SYNC_LOCK_PREFIX + spaceId,
        this.instanceId,
        String(GIT_SYNC_LOCK_TTL_MS),
      );
      // CAS miss (res !== 1): we no longer own the key — our TTL lapsed and
      // another replica may hold it now. Abort the in-flight cycle rather than
      // swallowing the loss and racing the working tree.
      if (res !== 1) {
        this.logger.warn(
          `git-sync: lock for space ${spaceId} lost during refresh — aborting in-flight cycle`,
        );
        controller?.abort();
      }
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to refresh lock for space ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // A refresh we cannot confirm means we may no longer hold the lock; abort.
      controller?.abort();
    }
  }

  /**
   * Run `fn` under the per-space lock: the in-process mutex (no overlapping
   * cycles on this instance) AND the Redis leader lock (single writer across
   * replicas). Returns `fn`'s result, or a skip sentinel when the lock could not
   * be acquired — `{ skipped: 'in-progress' }` (this instance is mid-cycle) or
   * `{ skipped: 'lock-held' }` (another replica holds the Redis lock). The mutex
   * + Redis lock are always released in a `finally`, even when `fn` throws (the
   * throw propagates to the caller). This is the single reusable wrapper shared
   * by `runOnce` (the poll/admin cycle) and `ingestExternalPush` (a push from a
   * git client over HTTP) so both serialize against each other identically.
   */
  async withSpaceLock<T>(
    spaceId: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | { skipped: 'lock-held' | 'in-progress' }> {
    if (this.running.has(spaceId)) {
      return { skipped: 'in-progress' };
    }
    // Cross-instance, same-process single-writer guard: another live holder (a
    // different SpaceLockService in this process) is mid-cycle for this space.
    // This survives a swallowed heartbeat / Redis TTL lapse, so a second writer
    // in the process cannot race the working tree — it is rejected 'lock-held'.
    if (SpaceLockService.liveLocks.has(spaceId)) {
      return { skipped: 'lock-held' };
    }
    // Reserve the in-process slot synchronously (before any await) so two
    // concurrent same-space calls on THIS instance cannot both pass the guard and
    // race acquire(). Redis NX is already authoritative across replicas; this just
    // closes the in-process TOCTOU window. Released in the outer finally on every
    // path (acquire-failure, fn-throw, normal completion).
    this.running.add(spaceId);
    SpaceLockService.liveLocks.set(spaceId, this.instanceId);
    try {
      if (!(await this.acquire(spaceId))) {
        return { skipped: 'lock-held' };
      }
      // Lost-lock signal: a failed/CAS-missed heartbeat refresh aborts this so the
      // protected fn can stop instead of writing blind after our lock lapsed.
      const controller = new AbortController();
      // Heartbeat: periodically (≈ TTL/3) extend the lock's TTL while `fn` runs so
      // a long push (client-controlled receive-pack + the Docmost cycle) cannot
      // outlive the fixed TTL and let a concurrent cycle race the working tree. The
      // refresh is CAS-guarded (only extends while WE own it). `.unref()` keeps the
      // timer from holding the event loop open; it is ALWAYS cleared in `finally`.
      const heartbeat = setInterval(() => {
        void this.refreshLock(spaceId, controller);
      }, Math.max(1, Math.floor(GIT_SYNC_LOCK_TTL_MS / 3)));
      heartbeat.unref?.();
      try {
        return await fn(controller.signal);
      } finally {
        clearInterval(heartbeat);
        await this.release(spaceId);
      }
    } finally {
      this.running.delete(spaceId);
      SpaceLockService.liveLocks.delete(spaceId);
    }
  }
}
