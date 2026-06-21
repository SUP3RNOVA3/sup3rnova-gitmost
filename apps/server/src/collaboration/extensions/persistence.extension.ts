import {
  afterUnloadDocumentPayload,
  Extension,
  onChangePayload,
  onLoadDocumentPayload,
  onStatelessPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { Injectable, Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  buildTitleSeedYdoc,
  getPageId,
  isEmptyParagraphDoc,
  jsonToText,
  tiptapExtensions,
} from '../collaboration.util';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { ProvenanceSource } from '../../core/auth/dto/jwt-payload';
import { Queue } from 'bullmq';
import {
  extractMentions,
  extractUserMentions,
} from '../../common/helpers/prosemirror/utils';
import { isDeepStrictEqual } from 'node:util';
import {
  IPageHistoryJob,
  IPageMentionNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import { Page } from '@docmost/db/types/entity.types';
import { CollabHistoryService } from '../services/collab-history.service';
import {
  HISTORY_FAST_INTERVAL,
  HISTORY_FAST_THRESHOLD,
  HISTORY_INTERVAL,
} from '../constants';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import { observeCollabStore } from '../../integrations/metrics/metrics.registry';

/**
 * #251 — wire format of the client→server stateless message that signals a
 * deliberate page clear. The client (IntentionalClear editor extension) sends
 * `{ type: INTENTIONAL_CLEAR_MESSAGE_TYPE }`; the document is taken from the
 * connection, not the payload, so the signal cannot be aimed at another page.
 */
export const INTENTIONAL_CLEAR_MESSAGE_TYPE = 'intentional-clear';

/**
 * #251 — how long an intentional-clear signal stays "pending" before it is
 * ignored. The signal is set on the clearing keystroke but consumed by the
 * DEBOUNCED onStoreDocument, so the TTL must comfortably exceed the collab
 * store debounce window (hocuspocus is configured with maxDebounce = 45s in
 * collaboration.gateway.ts). 60s leaves a margin while keeping the window for a
 * stale flag small; on top of the TTL, any non-empty store immediately drops a
 * pending flag (see onStoreDocument), so a "cleared then retyped" sequence can
 * never leave a usable flag behind.
 *
 * Known fail-safe limitation: the flag lives only in this node's process memory.
 * If document ownership transfers to another node, or this node crashes/restarts,
 * between the stateless signal (set on node A) and the debounced store, the
 * in-memory flag is lost and the clear is silently NOT applied — the store-side
 * empty-guard then reloads the document non-empty from the DB. This is
 * deliberately fail-safe (a lost flag preserves content rather than destroying
 * it), but it is a documented limitation, not a guarantee that every deliberate
 * clear survives a node handoff.
 */
export const INTENTIONAL_CLEAR_TTL_MS = 60_000;

/**
 * Resolve the provenance source for a coalesced snapshot.
 *
 * The snapshot is tagged 'agent' if any agent edit landed in the coalescing
 * window (sticky marker) OR if the current writer is the agent; otherwise
 * 'user'. Pure so the §15 H2 marker logic is unit-testable in isolation.
 */
export function resolveSource(
  stickyTouched: boolean,
  contextActor?: string,
): ProvenanceSource {
  return stickyTouched || contextActor === 'agent' ? 'agent' : 'user';
}

/**
 * Compute the BullMQ job id + delay for a page-history snapshot job. Pure so
 * the data-loss-sensitive timing arithmetic is unit-testable; `now` is injected
 * (caller passes `Date.now()`) for determinism.
 *
 * - Agent edits: delay 0 and a source-keyed job id `${page.id}-agent`. The
 *   delay MUST stay 0 — the worker re-reads the page row at run time, so any
 *   delay risks reading content a later human edit has already overwritten
 *   (mis-tagged snapshot). 0 minimizes that window. The `-agent` suffix keeps
 *   the job from coalescing with the bare-page.id human job.
 * - Human edits: age-based debounce so rapid human edits coalesce into one
 *   snapshot; job id is the bare `page.id`.
 *
 * BullMQ forbids ':' in custom job ids (Redis key separator), so '-' is used;
 * page.id is a UUID, so `${page.id}-agent` cannot collide with a human job.
 */
export function computeHistoryJob(
  page: Pick<Page, 'id' | 'createdAt'>,
  source: string,
  now: number,
): { jobId: string; delay: number } {
  const isAgent = source === 'agent';
  const pageAge = now - new Date(page.createdAt).getTime();
  const delay = isAgent
    ? 0
    : pageAge < HISTORY_FAST_THRESHOLD
      ? HISTORY_FAST_INTERVAL
      : HISTORY_INTERVAL;
  const jobId = isAgent ? `${page.id}-agent` : page.id;
  return { jobId, delay };
}

@Injectable()
export class PersistenceExtension implements Extension {
  private readonly logger = new Logger(PersistenceExtension.name);
  private contributors: Map<string, Set<string>> = new Map();
  // Sticky agent-edit marker (§15 H2): a coalesced snapshot may mix human and
  // agent edits. We accumulate "an agent touched this document during the
  // coalescing window" per document and OR it across all edits in the window,
  // so the snapshot is marked 'agent' regardless of who wrote last.
  private agentTouched: Map<string, boolean> = new Map();
  // #251 — per-document "intentional clear pending" flags. Keyed by
  // documentName, value = expiry timestamp (ms). Set by onStateless when the
  // client reports a deliberate clear; consumed once by the next
  // onStoreDocument empty-guard branch. This is the per-EDIT channel the
  // per-connection context cannot provide (a clear is an edit event, but the
  // store is debounced and connection context is fixed at authentication).
  private intentionalClear: Map<string, number> = new Map();

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageHistoryRepo: PageHistoryRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
    @InjectQueue(QueueName.HISTORY_QUEUE) private historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private readonly collabHistory: CollabHistoryService,
    private readonly transclusionService: TransclusionService,
  ) {}

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName, document } = data;
    const pageId = getPageId(documentName);

    if (!document.isEmpty('default')) {
      return;
    }

    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });

    if (!page) {
      this.logger.warn('page not found');
      return;
    }

    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const doc = new Y.Doc();
      const dbState = new Uint8Array(page.ydoc);

      Y.applyUpdate(doc, dbState);

      // Legacy pages persisted their title only in the `page.title` column; the
      // ydoc has no 'title' fragment. Seed it once so the client's
      // collaborative title editor can show/edit the title. This runs inside the
      // ydoc branch (NOT gated by the top-level 'default' body guard) because a
      // body that loaded from page.ydoc can still lack a title fragment. The
      // seed persists back to the DB so it is one-shot per page.
      const seeded = this.seedTitleFragment(doc, page.title);
      if (seeded) {
        await this.persistYdoc(doc, pageId);
      }

      return doc;
    }

    // NOTE (offline-sync M1, Goal 2): this per-load self-heal converts +
    // title-seeds + persists every legacy page (content set, ydoc null) on its
    // first open, which neutralizes the duplication trap incrementally. A
    // proactive one-shot BATCH migration over all such pages could be added
    // later, but it requires the tiptap schema + TiptapTransformer (Node/Yjs),
    // which a Kysely SQL migration cannot run; no runnable-task/CLI convention
    // exists in this repo yet, so we deliberately avoid a fragile migration.
    //
    // If no ydoc state in db, convert the JSON in page.content to a Y.Doc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      // Seed the title fragment for legacy pages here too, so the freshly built
      // ydoc carries the title from the page.title column.
      this.seedTitleFragment(ydoc, page.title);

      // DUPLICATION TRAP (classic Yjs): this rebuild produces a ydoc with FRESH
      // Yjs client-ids each time it runs. If we returned it WITHOUT persisting,
      // a later load would rebuild again with different client-ids, and a
      // long-offline client holding a ydoc derived from an EARLIER rebuild could
      // merge its update and DUPLICATE all the content (the two states share no
      // common ancestor). Persist the built ydoc to page.ydoc immediately so
      // every subsequent load takes the page.ydoc branch above and this rebuild
      // never runs again for this page (one-shot per page).
      await this.persistYdoc(ydoc, pageId);

      return ydoc;
    }

    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    return new Y.Doc();
  }

  /**
   * Seed the 'title' fragment of `doc` from the `page.title` column for legacy
   * pages whose persisted ydoc has no title fragment yet.
   *
   * Guarded STRICTLY by emptiness: we only seed when the existing 'title'
   * fragment is empty AND there is a non-empty column title. Seeding a non-empty
   * fragment would re-introduce the Yjs duplication trap, so we never do it.
   * Returns true when a seed was applied (so the caller can persist).
   * Defensive: a malformed title must not break document loading.
   */
  private seedTitleFragment(doc: Y.Doc, title: string | null): boolean {
    const trimmed = (title ?? '').trim();
    if (!trimmed) return false;

    try {
      const titleFrag = doc.get('title', Y.XmlFragment);
      if (titleFrag.length !== 0) return false;

      const titleSeed = buildTitleSeedYdoc(title);
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(titleSeed));
      this.logger.debug('seeded title fragment from page.title column');
      return true;
    } catch (err) {
      this.logger.warn(`failed to seed title fragment: ${err?.['message']}`);
      return false;
    }
  }

  /**
   * Persist the current state of `doc` into page.ydoc. Used by the one-shot
   * rebuild/seed self-heal in onLoadDocument so the conversion is durable and
   * never repeats. Defensive (try/catch + log): a persistence failure here must
   * NOT break document loading — the in-memory doc is still returned and the
   * next store will persist it anyway.
   */
  private async persistYdoc(doc: Y.Doc, pageId: string): Promise<void> {
    try {
      await this.pageRepo.updatePage(
        { ydoc: Buffer.from(Y.encodeStateAsUpdate(doc)) },
        pageId,
      );
      this.logger.debug(`persisted rebuilt/seeded ydoc: ${pageId}`);
    } catch (err) {
      this.logger.error(
        `Failed to persist rebuilt/seeded ydoc for page ${pageId}`,
        err,
      );
    }
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    // #355 — time the full store (persist + post-store side effects) into
    // collab_store_duration_seconds. No-op when METRICS_PORT is unset.
    const startedAt = performance.now();
    try {
      await this.storeDocument(data);
    } finally {
      observeCollabStore((performance.now() - startedAt) / 1000);
    }
  }

  private async storeDocument(data: onStoreDocumentPayload) {
    const { documentName, document, context } = data;

    const pageId = getPageId(documentName);

    const tiptapJson = TiptapTransformer.fromYdoc(document, 'default');

    const ydocState = Buffer.from(Y.encodeStateAsUpdate(document));

    let textContent = null;

    try {
      textContent = jsonToText(tiptapJson);
    } catch (err) {
      this.logger.warn('jsonToText' + err?.['message']);
    }

    // Title lives in the SAME Y.Doc as the body, in a dedicated 'title' fragment
    // (the collaborative title-editor contract with the client). Extract it
    // defensively: a malformed title fragment must NOT crash the document store.
    // `hasTitleFragment` distinguishes "the doc actually carries a title
    // fragment" from "legacy doc with no title fragment" — only the former may
    // write page.title, so a legacy doc never clobbers the column with ''.
    let titleText = '';
    let hasTitleFragment = false;
    try {
      const titleFrag = document.get('title', Y.XmlFragment);
      hasTitleFragment = !!titleFrag && titleFrag.length > 0;
      if (hasTitleFragment) {
        const titleJson = TiptapTransformer.fromYdoc(document, 'title');
        titleText = titleJson ? jsonToText(titleJson).trim() : '';
      }
    } catch (err) {
      this.logger.warn('title extraction: ' + err?.['message']);
      hasTitleFragment = false;
    }

    let page: Page = null;
    // Tracks whether the BODY ('default') changed in this store. The heavy
    // body-only side-effects (transclusion sync, mentions, RAG, history) stay
    // gated on this so a title-only change does not trigger them.
    let bodyChanged = false;
    // Tracks a successful title-only persist so the post-tx contributor folding
    // (collabHistory.addContributors) runs for the title-only case too.
    let titleOnlyPersisted = false;
    const editingUserIds = this.consumeContributors(documentName);
    // Sticky agent marker: 'agent' if any agent edit landed in this window, OR
    // if the current writer is the agent (covers a store with no prior onChange
    // agent event in the same window). §15 H2.
    const lastUpdatedSource = resolveSource(
      this.consumeAgentTouched(documentName),
      context?.actor,
    );
    // #251 — consume the intentional-clear flag ONCE, BEFORE the retry loop
    // (like consumeContributors / consumeAgentTouched above). consumeIntentional-
    // Clear ALWAYS deletes the in-memory Map entry, but a tx rollback cannot
    // un-delete it. Calling it INSIDE the loop meant: a clear armed for attempt 1
    // was consumed there, attempt 1's updatePage threw a transient error and
    // rolled back, then attempt 2 re-read non-empty content and saw the flag
    // already gone — silently downgrading the retry into a BLOCKED write, so the
    // user's deliberate clear was dropped. Hoisting makes the decision stable
    // across every attempt. This single call also preserves the "a non-empty
    // store drops a pending flag" semantics (the cleared-then-retyped case):
    // every store consumes the flag here regardless of incoming emptiness, so a
    // subsequent non-empty store can never leave a usable flag behind.
    const allowIntentionalClear = this.consumeIntentionalClear(documentName);

    // Persist with a small bounded retry. The in-memory Y.Doc is the ONLY copy
    // of the latest edit until this hook returns: hocuspocus destroys/unloads the
    // doc right after onStoreDocument resolves (see storeDocumentHooks' finally
    // -> unloadDocument). If a transient DB error (deadlock, serialization
    // failure, dropped connection) is merely logged and swallowed, the function
    // resolves "successfully", the doc is unloaded, and the edit is lost silently
    // (#206 persist-1). Retrying here re-attempts the write while we still hold
    // the doc; on total failure we clear `page` so the post-store side effects
    // (badge broadcast, history snapshot) never report a save that didn't happen.
    const MAX_STORE_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_STORE_ATTEMPTS; attempt++) {
      try {
        await executeTx(this.db, async (trx) => {
          page = await this.pageRepo.findById(pageId, {
            withLock: true,
            includeContent: true,
            trx,
          });

          if (!page) {
            this.logger.error(`Page with id ${pageId} not found`);
            return;
          }

          bodyChanged = !isDeepStrictEqual(tiptapJson, page.content);
          // Only a populated 'title' fragment may update page.title; compare
          // against the current column value (treat null as '').
          const titleChanged =
            hasTitleFragment && titleText !== (page.title ?? '');

          // No-op fast path: neither body nor title changed.
          if (!bodyChanged && !titleChanged) {
            page = null;
            return;
          }

          // Title-only change: the body is unchanged, so skip the heavy body
          // history/contributor logic and persist just the new title and the
          // ydoc (the title fragment edit lives in the same ydoc). The early-skip
          // used to drop this case entirely, losing the title change.
          if (!bodyChanged) {
            // Fold the window's editing users into contributors the same way the
            // body branch does, so a user who edited ONLY the title is not dropped
            // from page.contributorIds.
            const contributorIds = Array.from(
              new Set([
                ...(page.contributorIds || []),
                ...editingUserIds,
                page.creatorId,
              ]),
            );
            await this.pageRepo.updatePage(
              {
                title: titleText,
                ydoc: ydocState,
                lastUpdatedById: context.user.id,
                contributorIds,
                // A title-only change is not a body-authorship transition; leave
                // lastUpdatedSource/aiChatId untouched so the user->agent history
                // boundary in the body branch is not bypassed.
              },
              pageId,
              trx,
              // Mirror PageService.update's tree snapshot so a collaborative rename
              // propagates to other users' sidebar/breadcrumbs like the REST rename.
              {
                treeUpdate: {
                  id: pageId,
                  slugId: page.slugId,
                  spaceId: page.spaceId,
                  parentPageId: page.parentPageId ?? null,
                  title: titleText,
                },
              },
            );
            this.logger.debug(`Page title updated: ${pageId} - SlugId: ${page.slugId}`);
            titleOnlyPersisted = true;
            return;
          }

          // #206 persist-6 / #248 — store-side empty-guard. A momentarily-empty
          // live Y.Doc (a client/agent glitch, a bad merge, a transclusion that
          // emptied) must NOT overwrite non-empty persisted content. The LOAD
          // path already guards emptiness (onLoadDocument only hydrates from db
          // when the live doc isEmpty); the STORE path did not, so an empty
          // serialization was written straight over the page, wiping it
          // silently. Reached only when the body actually changed (the title-only
          // fast path above already returned).
          //
          // #251 — the ONE legitimate empty-over-non-empty write is a user who
          // deliberately clears the page. That intent arrives out-of-band as a
          // stateless message, NOT from the doc content, which is why it cannot
          // be spoofed for non-clear writes: the flag is only ever read on this
          // empty-incoming branch, so the worst a forged signal can do is clear
          // a page the connection may already edit. The flag was consumed ONCE
          // before the retry loop (`allowIntentionalClear`) so the decision is
          // stable across retries; a non-empty store still drops any pending
          // flag via that same hoisted consume (a "cleared then retyped"
          // sequence can't leave a usable one behind).
          const incomingEmpty = isEmptyParagraphDoc(tiptapJson as any);
          if (
            incomingEmpty &&
            page.content &&
            !isEmptyParagraphDoc(page.content as any)
          ) {
            if (allowIntentionalClear) {
              this.logger.debug(
                `Intentional clear for ${pageId}: persisting empty doc over ` +
                  `non-empty content (user-signalled)`,
              );
              // fall through — the empty write is allowed exactly once.
            } else {
              this.logger.warn(
                `Skipping store for ${pageId}: empty live doc would overwrite ` +
                  `non-empty persisted content`,
              );
              page = null;
              return;
            }
          }

          let contributorIds = undefined;
          try {
            const existingContributors = page.contributorIds || [];
            contributorIds = Array.from(
              new Set([
                ...existingContributors,
                ...editingUserIds,
                page.creatorId,
              ]),
            );
          } catch (err) {
            //this.logger.debug('Contributors error:' + err?.['message']);
          }

          // Approach A — boundary snapshot before the agent's first edit.
          // When this store is the agent's and the page's currently persisted
          // state was authored by a human, pin that human state as its own
          // history version BEFORE the agent overwrites it. `page` still holds
          // the OLD content/provenance here, so saveHistory(page) captures the
          // pre-agent state tagged 'user'. The agent's new content is
          // snapshotted later by the debounced PAGE_HISTORY job ('agent'). Skip
          // if the prior state is already agent-authored (boundary already
          // pinned on the user->agent transition), if the page is effectively
          // empty, or if the latest existing snapshot already equals this human
          // state (avoid duplicates).
          if (
            lastUpdatedSource === 'agent' &&
            page.lastUpdatedSource !== 'agent'
          ) {
            // pageHistory.pageId is uuid-typed; use page.id (never the doc-name
            // slugId) so a `page.<slugId>` doc cannot throw 22P02 here (#260).
            const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
              page.id,
              { includeContent: true, trx },
            );
            const humanBaselineMissing =
              !lastHistory || !isDeepStrictEqual(lastHistory.content, page.content);
            if (!isEmptyParagraphDoc(page.content as any) && humanBaselineMissing) {
              await this.pageHistoryRepo.saveHistory(page, {
                contributorIds: page.contributorIds ?? undefined,
                trx,
              });
            }
          }

          await this.pageRepo.updatePage(
            {
              content: tiptapJson,
              textContent: textContent,
              ydoc: ydocState,
              lastUpdatedById: context.user.id,
              // Human stays the responsible author; these annotate the source.
              lastUpdatedSource,
              lastUpdatedAiChatId: context?.aiChatId ?? null,
              contributorIds: contributorIds,
              // Persist the title in the SAME transaction when the title fragment
              // changed alongside the body.
              ...(titleChanged ? { title: titleText } : {}),
            },
            pageId,
            trx,
            // Mirror PageService.update's tree snapshot so a collaborative rename
            // propagates to other users' sidebar/breadcrumbs like the REST rename.
            // Only attach when the title actually changed; a body-only save must
            // not trigger a tree broadcast.
            titleChanged
              ? {
                  treeUpdate: {
                    id: pageId,
                    slugId: page.slugId,
                    spaceId: page.spaceId,
                    parentPageId: page.parentPageId ?? null,
                    title: titleText,
                  },
                }
              : undefined,
          );

          this.logger.debug(`Page updated: ${pageId} - SlugId: ${page.slugId}`);
        });
        break;
      } catch (err) {
        this.logger.error(
          `Failed to update page ${pageId} (attempt ${attempt}/${MAX_STORE_ATTEMPTS})`,
          err,
        );
        // The write failed and rolled back; clear the partially-assigned `page`
        // so the post-store success branch below is skipped (no false "saved"
        // broadcast / history snapshot for content that was never persisted).
        page = null;
        if (attempt < MAX_STORE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 50));
        }
      }
    }

    // `page` is truthy whenever anything was persisted (body OR title-only), so
    // the page.updated broadcast fires for a title-only change too.
    if (page) {
      document.broadcastStateless(
        JSON.stringify({
          type: 'page.updated',
          updatedAt: new Date().toISOString(),
          // Provenance for a future live badge; 'user' for human edits.
          source: lastUpdatedSource,
          lastUpdatedById: context?.user?.id,
          lastUpdatedBy: context?.user
            ? {
                id: context.user?.id,
                name: context.user?.name,
                avatarUrl: context.user?.avatarUrl,
              }
            : undefined,
        }),
      );
    }

    // Record the window's editing users in collab history for a title-only
    // change too (the body branch does this below, gated on bodyChanged). Key
    // contributors by the canonical page UUID (page.id), not the doc-name id
    // which may be a slugId, so they MATCH the PAGE_HISTORY job which is
    // enqueued with page.id and pops contributors by page.id (#260).
    if (page && titleOnlyPersisted) {
      await this.collabHistory.addContributors(page.id, editingUserIds);
    }

    // Body-only side-effects: skip them for a title-only change (body unchanged).
    if (page && bodyChanged) {
      // Use the canonical page UUID (page.id), not the doc-name id, which may be
      // a slugId for a `page.<slugId>` doc (#260). The transclusion/reference
      // syncs write uuid-typed columns, so a slugId here threw Postgres 22P02.
      await this.syncTransclusion(page.id, page.workspaceId, tiptapJson);
    }

    if (page && bodyChanged) {
      // Key contributors by the page UUID so they MATCH the PAGE_HISTORY job,
      // which is enqueued with page.id and pops contributors by page.id (#260).
      await this.collabHistory.addContributors(page.id, editingUserIds);

      const mentions = extractMentions(tiptapJson);

      const userMentions = extractUserMentions(mentions);
      const oldMentions = page.content ? extractMentions(page.content) : [];
      const oldMentionedUserIds = extractUserMentions(oldMentions).map(
        (m) => m.entityId,
      );

      if (userMentions.length > 0) {
        await this.notificationQueue.add(QueueJob.PAGE_MENTION_NOTIFICATION, {
          userMentions: userMentions.map((m) => ({
            userId: m.entityId,
            mentionId: m.id,
            creatorId: m.creatorId,
          })),
          oldMentionedUserIds,
          // Canonical UUID, never the doc-name slugId (#260).
          pageId: page.id,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
        } as IPageMentionNotificationJob);
      }

      await this.aiQueue.add(QueueJob.PAGE_CONTENT_UPDATED, {
        // Canonical UUID: the embedding reindex resolves pages by uuid, so a
        // slugId here threw Postgres 22P02 invalid-uuid (#260).
        pageIds: [page.id],
        workspaceId: page.workspaceId,
      });

      await this.enqueuePageHistory(page, lastUpdatedSource);
    }
  }

  /**
   * #251 — receive the client's deliberate-clear signal. Records a short-lived,
   * single-use pending flag for the originating document so the next
   * onStoreDocument may let one empty-over-non-empty write through the guard.
   *
   * Hardening: read-only connections cannot arm the flag, and the document is
   * taken from the connection (`data.documentName`), never the payload, so a
   * client cannot target a page it isn't editing. The flag only ever RELAXES
   * the guard for an empty write (a clear); it can never force or alter a
   * non-empty write, so it is not a guard bypass for normal content.
   */
  async onStateless(data: onStatelessPayload) {
    const { connection, documentName, payload } = data;

    if (connection?.readOnly) return;

    let message: { type?: string } | undefined;
    try {
      message = JSON.parse(payload);
    } catch {
      return; // unrelated / malformed stateless message
    }

    if (message?.type !== INTENTIONAL_CLEAR_MESSAGE_TYPE) return;

    this.intentionalClear.set(
      documentName,
      Date.now() + INTENTIONAL_CLEAR_TTL_MS,
    );
  }

  async onChange(data: onChangePayload) {
    const documentName = data.documentName;
    const userId = data.context?.user?.id;

    if (!userId) return;

    if (!this.contributors.has(documentName)) {
      this.contributors.set(documentName, new Set());
    }

    this.contributors.get(documentName).add(userId);

    // Sticky agent marker: once an agent connection touches the document in the
    // coalescing window, keep it marked until the next snapshot consumes it.
    if (data.context?.actor === 'agent') {
      this.agentTouched.set(documentName, true);
    }
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const documentName = data.documentName;
    this.contributors.delete(documentName);
    this.agentTouched.delete(documentName);
    this.intentionalClear.delete(documentName);
  }

  private consumeContributors(documentName: string): string[] {
    const contributorSet = this.contributors.get(documentName);
    if (!contributorSet) return [];
    const userIds = [...contributorSet];
    this.contributors.delete(documentName);
    return userIds;
  }

  /** Read and clear the sticky agent-touched flag for this coalescing window. */
  private consumeAgentTouched(documentName: string): boolean {
    const touched = this.agentTouched.get(documentName) ?? false;
    this.agentTouched.delete(documentName);
    return touched;
  }

  /**
   * #251 — read and clear the intentional-clear flag for this document. Returns
   * true only if a flag was pending AND still within its TTL. Always deletes the
   * entry so the signal is strictly single-use (one clear → one allowed empty
   * write); an expired flag is treated as absent (guard still blocks).
   */
  private consumeIntentionalClear(documentName: string): boolean {
    const expiry = this.intentionalClear.get(documentName);
    this.intentionalClear.delete(documentName);
    return expiry !== undefined && Date.now() < expiry;
  }

  private async enqueuePageHistory(
    page: Page,
    lastUpdatedSource: string,
  ): Promise<void> {
    // Job id + delay arithmetic lives in the pure `computeHistoryJob` (see its
    // doc comment for the agent-delay-0 / age-based-debounce invariants).
    const { jobId, delay } = computeHistoryJob(
      page,
      lastUpdatedSource,
      Date.now(),
    );

    await this.historyQueue.add(
      QueueJob.PAGE_HISTORY,
      { pageId: page.id } as IPageHistoryJob,
      { jobId, delay },
    );
  }

  /**
   * Refresh `page_transclusions` and `page_transclusion_references` to match
   * the page's current content. Runs outside the page-write transaction and
   * isolates each call so a failure here cannot affect the page save itself.
   * The diff is idempotent — the next save converges if a round drops anything.
   */
  private async syncTransclusion(
    pageId: string,
    workspaceId: string,
    tiptapJson: unknown,
  ): Promise<void> {
    try {
      await this.transclusionService.syncPageTransclusions(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusions for page',
      );
    }
    try {
      await this.transclusionService.syncPageReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusion references for page',
      );
    }
    try {
      await this.transclusionService.syncPageTemplateReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync page template references for page',
      );
    }
  }
}
