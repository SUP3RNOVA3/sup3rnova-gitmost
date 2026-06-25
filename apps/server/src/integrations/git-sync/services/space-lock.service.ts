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
   * working tree. Logs (warn) but never throws — a failed refresh must not break
   * the cycle it is protecting.
   */
  private async refreshLock(spaceId: string): Promise<void> {
    const lua =
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
    try {
      await this.redis.eval(
        lua,
        1,
        GIT_SYNC_LOCK_PREFIX + spaceId,
        this.instanceId,
        String(GIT_SYNC_LOCK_TTL_MS),
      );
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to refresh lock for space ${spaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
    fn: () => Promise<T>,
  ): Promise<T | { skipped: 'lock-held' | 'in-progress' }> {
    if (this.running.has(spaceId)) {
      return { skipped: 'in-progress' };
    }
    // Reserve the in-process slot synchronously (before any await) so two
    // concurrent same-space calls on THIS instance cannot both pass the guard and
    // race acquire(). Redis NX is already authoritative across replicas; this just
    // closes the in-process TOCTOU window. Released in the outer finally on every
    // path (acquire-failure, fn-throw, normal completion).
    this.running.add(spaceId);
    try {
      if (!(await this.acquire(spaceId))) {
        return { skipped: 'lock-held' };
      }
      // Heartbeat: periodically (≈ TTL/3) extend the lock's TTL while `fn` runs so
      // a long push (client-controlled receive-pack + the Docmost cycle) cannot
      // outlive the fixed TTL and let a concurrent cycle race the working tree. The
      // refresh is CAS-guarded (only extends while WE own it). `.unref()` keeps the
      // timer from holding the event loop open; it is ALWAYS cleared in `finally`.
      const heartbeat = setInterval(() => {
        void this.refreshLock(spaceId);
      }, Math.max(1, Math.floor(GIT_SYNC_LOCK_TTL_MS / 3)));
      heartbeat.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(heartbeat);
        await this.release(spaceId);
      }
    } finally {
      this.running.delete(spaceId);
    }
  }
}
