/**
 * Git-sync control-plane constants (plan §6/§9/§10).
 *
 * Event/job names are REUSED from the shared event contract (event.contants.ts)
 * so the listener subscribes to the exact names the rest of the server emits —
 * never a string literal that could drift. The Redis lock-key prefix + TTLs back
 * the single-writer leader lock (§9); the debounce default backs the per-space
 * event coalescing (§10).
 */
import { EventName } from '../../common/events/event.contants';

/**
 * The page lifecycle events the git-sync listener reacts to (plan §10). A change
 * to any of these in an enabled space schedules a debounced sync cycle.
 *   - PAGE_CREATED / PAGE_UPDATED / PAGE_MOVED — structural + content edits;
 *   - PAGE_CONTENT_UPDATED — the collab body-save job (real name in the enum);
 *   - PAGE_SOFT_DELETED / PAGE_RESTORED — Trash transitions (deletes are soft);
 *   - PAGE_MOVED_TO_SPACE — cross-space move (cross-repo, plan §5).
 */
export const GIT_SYNC_PAGE_EVENTS = [
  EventName.PAGE_CREATED,
  EventName.PAGE_UPDATED,
  EventName.PAGE_CONTENT_UPDATED,
  EventName.PAGE_MOVED,
  EventName.PAGE_MOVED_TO_SPACE,
  EventName.PAGE_SOFT_DELETED,
  EventName.PAGE_RESTORED,
] as const;

/** Redis key prefix for the per-space leader lock (plan §9). */
export const GIT_SYNC_LOCK_PREFIX = 'git-sync:lock:';

/**
 * Leader-lock TTL (ms). Must exceed the maximum expected cycle duration so the
 * lock is not lost mid-cycle; on a crash it expires on its own (plan §9). The
 * in-process mutex (orchestrator) prevents overlapping cycles on one instance,
 * and the Redis lock prevents two instances racing the same space.
 */
export const GIT_SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

/** Default event-debounce window (ms), overridable via GIT_SYNC_DEBOUNCE_MS. */
export const GIT_SYNC_DEBOUNCE_MS_DEFAULT = 2000;

/** Default poll-safety interval (ms), overridable via GIT_SYNC_POLL_INTERVAL_MS. */
export const GIT_SYNC_POLL_INTERVAL_MS_DEFAULT = 15000;
