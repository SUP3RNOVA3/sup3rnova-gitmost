import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { EnvironmentService } from '../../environment/environment.service';
import { GitSyncOrchestrator } from '../services/git-sync.orchestrator';
import { GIT_SYNC_PAGE_EVENTS } from '../git-sync.constants';

/**
 * Shape of the page domain events the listener consumes. Different emit sites
 * carry different optional fields (page.repo `PageEvent`, `PageMovedEvent`,
 * etc.), so this is the intersection we read: a `pageIds` list / single `pageId`,
 * the `workspaceId`, and an OPTIONAL `spaceId` (present only on some events). When
 * `spaceId` is absent we resolve it from the page row.
 */
interface PageEventLike {
  pageIds?: string[];
  pageId?: string;
  workspaceId?: string;
  spaceId?: string;
  pages?: { id: string; spaceId: string }[];
  node?: { id: string; spaceId: string };
}

/** Per-space debounce bookkeeping. */
interface DebounceEntry {
  timer: NodeJS.Timeout;
  workspaceId: string;
}

/**
 * Event-driven trigger for the git-sync control plane (plan §10). Subscribes to
 * the page lifecycle events and, for an enabled space, schedules a DEBOUNCED
 * `orchestrator.runOnce(spaceId, workspaceId)` — coalescing a burst of edits into
 * a single cycle per space.
 *
 * Loop-guard (best-effort, plan §10/§8.2): an event whose page row already reads
 * `lastUpdatedSource === 'git-sync'` is the orchestrator's OWN write, so we skip
 * it to avoid a write -> event -> sync echo. The guard ALWAYS runs (the page row
 * is fetched for every event, structural ones included). This is the cheap first
 * guard; the
 * full bodyHash + updatedAt loop-guard (consuming the push side's
 * `PushedPageRecord`) is a later hardening step (plan §8.2) — noted, not built
 * here. The poll-safety interval still converges anything this guard drops.
 */
@Injectable()
export class PageChangeListener {
  private readonly logger = new Logger(PageChangeListener.name);
  private readonly debounce = new Map<string, DebounceEntry>();

  constructor(
    private readonly environmentService: EnvironmentService,
    private readonly orchestrator: GitSyncOrchestrator,
    private readonly pageRepo: PageRepo,
  ) {}

  /**
   * One handler bound to ALL git-sync page events (the array form of `@OnEvent`).
   * Fetches the page row once to apply the loop-guard (unconditionally) and to
   * resolve the page's space + workspace, then schedules the debounced cycle.
   */
  @OnEvent(GIT_SYNC_PAGE_EVENTS as unknown as string[])
  async handlePageEvent(event: PageEventLike): Promise<void> {
    if (!this.environmentService.isGitSyncEnabled()) return;

    try {
      const pageId = this.firstPageId(event);
      if (!pageId) return;

      // The loop-guard MUST always run — even structural events that already
      // carry spaceId+workspaceId could be the orchestrator's OWN write (it stamps
      // lastUpdatedSource='git-sync' on create/update/move/rename + body writes).
      // So ALWAYS fetch the page row: it gives us the loop-guard source AND fills
      // in any missing space/workspace in a single read. A missing page
      // (hard-deleted) is ignored.
      const page = await this.pageRepo.findById(pageId, {
        includeContent: false,
      });
      if (!page) return;

      // Loop-guard: skip our own writes to avoid a write -> event -> sync echo
      // (best-effort, plan §8.2). Applies unconditionally now.
      if (page.lastUpdatedSource === 'git-sync') return;

      // Prefer ids carried on the event; fall back to the row we already fetched.
      const spaceId = this.eventSpaceId(event, pageId) ?? page.spaceId;
      const workspaceId = event.workspaceId ?? page.workspaceId;

      if (!spaceId || !workspaceId) return;
      this.schedule(spaceId, workspaceId);
    } catch (err) {
      this.logger.warn(
        `git-sync: failed to handle page event: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Pull the first affected pageId out of the heterogeneous event shapes. */
  private firstPageId(event: PageEventLike): string | undefined {
    return (
      event.pageId ??
      event.pageIds?.[0] ??
      event.pages?.[0]?.id ??
      event.node?.id
    );
  }

  /** A spaceId carried directly on the event, for the given pageId if scoped. */
  private eventSpaceId(
    event: PageEventLike,
    pageId: string,
  ): string | undefined {
    if (event.spaceId) return event.spaceId;
    const fromPages = event.pages?.find((p) => p.id === pageId)?.spaceId;
    if (fromPages) return fromPages;
    if (event.node?.id === pageId) return event.node.spaceId;
    return undefined;
  }

  /**
   * Debounce per space: a new event resets the timer so a burst collapses into a
   * single cycle. On fire, `runOnce` is enqueued (it internally serializes via the
   * in-process mutex + Redis lock, so a still-running cycle is simply skipped and
   * the next event reschedules).
   */
  private schedule(spaceId: string, workspaceId: string): void {
    const existing = this.debounce.get(spaceId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.debounce.delete(spaceId);
      void this.orchestrator
        .runOnce(spaceId, workspaceId)
        .catch((err) =>
          this.logger.error(
            `git-sync: debounced cycle for space ${spaceId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }, this.environmentService.getGitSyncDebounceMs());

    // Do not keep the event loop alive solely for a pending sync.
    timer.unref?.();
    this.debounce.set(spaceId, { timer, workspaceId });
  }
}
