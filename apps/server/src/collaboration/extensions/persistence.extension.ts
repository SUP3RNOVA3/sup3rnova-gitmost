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
  EMBED_DEBOUNCE_MS,
  IDLE_INTERVAL_AGENT,
  IDLE_INTERVAL_USER,
  IDLE_MAX_WAIT_AGENT,
  IDLE_MAX_WAIT_USER,
  PageHistoryKind,
} from '../constants';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import {
  observeCollabLoad,
  observeCollabStore,
} from '../../integrations/metrics/metrics.registry';
import { hasTransclusionFamilyNodes } from '../../core/page/transclusion/utils/transclusion-prosemirror.util';

/**
 * #251 — wire format of the client→server stateless message that signals a
 * deliberate page clear. The client (IntentionalClear editor extension) sends
 * `{ type: INTENTIONAL_CLEAR_MESSAGE_TYPE }`; the document is taken from the
 * connection, not the payload, so the signal cannot be aimed at another page.
 */
export const INTENTIONAL_CLEAR_MESSAGE_TYPE = 'intentional-clear';

/**
 * #370 — wire format of the client→server "save a version" signal. Sent by the
 * human (Cmd+S / Save button) and by the agent's explicit save tool over the
 * SAME stateless channel. The intentionality tier ('manual' vs 'agent') is
 * derived SERVER-SIDE from the signed connection actor, never from this
 * payload, so a version's type is unforgeable. The document is taken from the
 * connection (not the payload), so the signal cannot be aimed at another page.
 */
export const SAVE_VERSION_MESSAGE_TYPE = 'save-version';

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
 * #370 — compute the BullMQ job id + delay for a page's trailing idle-flush
 * autosnapshot. Pure so the timing is unit-testable.
 *
 * Both humans and the agent now share ONE idle pipeline (the agent's old
 * `delay=0` fast path is gone — intentional agent points arrive via the
 * explicit save-version signal instead). The job id is the bare `page.id`, so a
 * page has at most one pending idle job; the caller removes-and-re-adds it on
 * every store to keep it debounced to the trailing edge of an edit burst. The
 * window differs by source only: the agent flushes sooner than a human.
 */
export function computeHistoryJob(
  page: Pick<Page, 'id'>,
  source: string,
  // Epoch ms of the FIRST edit in the current burst (when the pending idle job
  // was first armed). Used to enforce the max-wait ceiling so a continuous
  // editing session cannot re-arm the trailing timer forever. `now` is injectable
  // for tests; both default to a live clock / no ceiling when omitted.
  burstStart?: number,
  now: number = Date.now(),
): { jobId: string; delay: number } {
  const isAgent = source === 'agent';
  const interval = isAgent ? IDLE_INTERVAL_AGENT : IDLE_INTERVAL_USER;
  const maxWait = isAgent ? IDLE_MAX_WAIT_AGENT : IDLE_MAX_WAIT_USER;

  let delay = interval;
  if (burstStart !== undefined) {
    // Time already elapsed since the burst's first edit; the snapshot must fire
    // no later than `maxWait` after that, so shrink the trailing delay to the
    // remaining budget (never negative, so BullMQ fires it promptly).
    const remaining = burstStart + maxWait - now;
    delay = Math.max(0, Math.min(interval, remaining));
  }
  return { jobId: page.id, delay };
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
  // #370 — epoch ms of the FIRST edit in the current idle-flush burst, per page.
  // Set when the pending idle job is first armed (empty entry), read to enforce
  // the max-wait ceiling in computeHistoryJob, and cleared when the idle job is
  // consumed/cancelled so the next burst starts a fresh window.
  private idleBurstStart: Map<string, number> = new Map();
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

    // #402 — the early return below (live doc already non-empty) does NOT touch
    // the DB, so it is deliberately NOT timed. We only observe the real DB-load
    // work, and only on each real-load return, tagged by the loaded doc size.
    if (!document.isEmpty('default')) {
      return;
    }

    const startedAt = performance.now();
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });

    if (!page) {
      this.logger.warn('page not found');
      return;
    }

    // #401 fix 2 — apply the DB state DIRECTLY into the hook's target document
    // (`document` === `data.document`) and return undefined. When onLoadDocument
    // returns undefined, hocuspocus keeps the mutated hook document as-is; only
    // when the hook RETURNS a Y.Doc does hocuspocus re-`applyUpdate(document,
    // encodeStateAsUpdate(returned))` — a second full encode+apply of the whole
    // (e.g. 315KB) state on every cold load. Mutating in place performs a single
    // apply and avoids the throwaway `new Y.Doc()` allocation.
    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const dbState = new Uint8Array(page.ydoc);

      Y.applyUpdate(document, dbState);
      observeCollabLoad(dbState.length, (performance.now() - startedAt) / 1000);
      return;
    }

    // if no ydoc state in db convert json in page.content to Ydoc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      // Encode the converted doc ONCE, reuse the bytes for both the size label
      // and the single apply into the hook document (previously this encode's
      // result was returned and hocuspocus re-encoded+applied it a second time).
      const encoded = Y.encodeStateAsUpdate(ydoc);
      Y.applyUpdate(document, encoded);
      observeCollabLoad(
        encoded.byteLength,
        (performance.now() - startedAt) / 1000,
      );
      return;
    }

    // No persisted state: the hook document is already a fresh empty Y.Doc, so
    // leave it untouched and return undefined (no re-encode of an empty doc).
    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    observeCollabLoad(0, (performance.now() - startedAt) / 1000);
    return;
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    // #355 — time the full store (persist + post-store side effects) into
    // collab_store_duration_seconds. #402 — also tag by document size bucket.
    // No-op when METRICS_PORT is unset.
    const startedAt = performance.now();
    // Default 0 so a throw before storeDocument returns still records a
    // (smallest-bucket) observation rather than dropping the timing entirely.
    let bytes = 0;
    try {
      bytes = await this.storeDocument(data);
    } finally {
      observeCollabStore(bytes, (performance.now() - startedAt) / 1000);
    }
  }

  /**
   * Persist the document. Returns the serialized ydoc byte size (used as the
   * store histogram's size_bucket). The single Y.encodeStateAsUpdate below is
   * the ONLY serialization — its byteLength is reused for the label (no second
   * encode).
   */
  private async storeDocument(data: onStoreDocumentPayload): Promise<number> {
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

    let page: Page = null;
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

          if (isDeepStrictEqual(tiptapJson, page.content)) {
            page = null;
            return;
          }

          // #206 persist-6 / #248 — store-side empty-guard. A momentarily-empty
          // live Y.Doc (a client/agent glitch, a bad merge, a transclusion that
          // emptied) must NOT overwrite non-empty persisted content. The LOAD
          // path already guards emptiness (onLoadDocument only hydrates from db
          // when the live doc isEmpty); the STORE path did not, so an empty
          // serialization was written straight over the page, wiping it
          // silently.
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

          // #370 — boundary snapshot on ANY source transition. When the store
          // flips the page's provenance (user↔agent↔git), pin the OUTGOING
          // state as its own history version BEFORE the incoming source
          // overwrites it. `page` still holds the OLD content/provenance here,
          // so saveHistory(page) captures the pre-transition state tagged with
          // its own source, kind='boundary'. The incoming content is snapshotted
          // later by the debounced idle job. Skip if the page is effectively
          // empty or if the latest existing snapshot already equals this state
          // (the shared isDeepStrictEqual gate — avoids duplicates). Generalizing
          // beyond the old user→agent special-case also covers git-sync for free.
          if (
            page.lastUpdatedSource &&
            page.lastUpdatedSource !== lastUpdatedSource
          ) {
            // pageHistory.pageId is uuid-typed; use page.id (never the doc-name
            // slugId) so a `page.<slugId>` doc cannot throw 22P02 here (#260).
            const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
              page.id,
              { includeContent: true, trx },
            );
            const baselineMissing =
              !lastHistory ||
              !isDeepStrictEqual(lastHistory.content, page.content);
            if (!isEmptyParagraphDoc(page.content as any) && baselineMissing) {
              await this.pageHistoryRepo.saveHistory(page, {
                contributorIds: page.contributorIds ?? undefined,
                kind: 'boundary',
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
            },
            pageId,
            trx,
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

      // Use the canonical page UUID (page.id), not the doc-name id, which may be
      // a slugId for a `page.<slugId>` doc (#260). The transclusion/reference
      // syncs write uuid-typed columns, so a slugId here threw Postgres 22P02.
      //
      // #348 — skip the three sync SELECTs when neither the new content nor the
      // previously-persisted content has any transclusion/reference/pageEmbed
      // node: nothing to insert, and (the DB mirrors the old content) nothing to
      // delete. Whenever either side has one, run the idempotent sync exactly as
      // before so removals are still reconciled.
      if (
        hasTransclusionFamilyNodes(tiptapJson) ||
        hasTransclusionFamilyNodes(page.content)
      ) {
        await this.syncTransclusion(page.id, page.workspaceId, tiptapJson);
      }
    }

    if (page) {
      // Key contributors by the page UUID so they MATCH the PAGE_HISTORY job,
      // which is enqueued with page.id and pops contributors by page.id (#260).
      await this.collabHistory.addContributors(page.id, editingUserIds);

      const mentions = extractMentions(tiptapJson);

      const userMentions = extractUserMentions(mentions);
      const oldMentions = page.content ? extractMentions(page.content) : [];
      const oldMentionedUserIds = extractUserMentions(oldMentions).map(
        (m) => m.entityId,
      );

      // #348 — only enqueue when the mentioned-user set actually GAINED a member.
      // The processor (processPageMention) already no-ops when every current
      // mention was present before (newMentions.length === 0), so skipping the
      // enqueue in that case is behavior-identical and avoids piling up no-op jobs
      // on every save of a page that merely CONTAINS (unchanged) mentions.
      const oldMentionedUserIdSet = new Set(oldMentionedUserIds);
      const hasNewMentionedUser = userMentions.some(
        (m) => !oldMentionedUserIdSet.has(m.entityId),
      );

      if (hasNewMentionedUser) {
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

      await this.aiQueue.add(
        QueueJob.PAGE_CONTENT_UPDATED,
        {
          // Canonical UUID: the embedding reindex resolves pages by uuid, so a
          // slugId here threw Postgres 22P02 invalid-uuid (#260).
          pageIds: [page.id],
          workspaceId: page.workspaceId,
        },
        // #348 — coalesce re-embeds during active editing. A stable per-page
        // jobId + delay means repeated saves within EMBED_DEBOUNCE_MS collapse
        // to one delayed job instead of one expensive re-embed per save. The
        // worker reads the current page state at run time, so last content wins.
        // BullMQ forbids ':' in custom job ids (Redis key separator), so '-' is
        // used; page.id is a UUID, so the id is unique per page. removeOnComplete
        // (queue.module) frees the id after each run so the next window re-arms.
        { jobId: `embed-${page.id}`, delay: EMBED_DEBOUNCE_MS },
      );

      await this.enqueuePageHistory(page, lastUpdatedSource);
    }

    // #402 — report the serialized size for the store histogram's size_bucket.
    // ydocState is always computed above (there is no earlier no-write return in
    // this method), so this reflects the doc that was serialized this store.
    return ydocState.byteLength;
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

    // #370 — explicit "save a version" (human Cmd+S / agent save tool). Edit
    // rights are already enforced by the readOnly reject above (a reader can't
    // create a version), exactly as intentional-clear requires.
    if (message?.type === SAVE_VERSION_MESSAGE_TYPE) {
      await this.handleSaveVersion(data);
      return;
    }

    if (message?.type !== INTENTIONAL_CLEAR_MESSAGE_TYPE) return;

    this.intentionalClear.set(
      documentName,
      Date.now() + INTENTIONAL_CLEAR_TTL_MS,
    );
  }

  /**
   * #370 — persist an intentional version from the live in-memory ydoc.
   *
   * One stateless path serves BOTH the human and the agent; the tier is derived
   * SERVER-SIDE from the signed connection actor ('agent' → 'agent', anything
   * else → 'manual'), so the version type cannot be spoofed by the client. We
   * take the fresh ydoc from the collab process memory and run it through the
   * EXISTING store path first (so pages.content/ydoc reflect the exact content
   * being versioned — a REST endpoint would race the up-to-10s-stale page row),
   * then snapshot it into page_history with the intentional kind.
   *
   * Promote-not-dup: if the latest history row already holds this exact content
   * and it is an autosave (idle/boundary/legacy-null), upgrade its kind in place
   * instead of duplicating a heavy content row; if it is already 'manual', it is
   * a no-op (the client shows an "already saved" toast). Otherwise a fresh
   * version row is written, popping the aggregated contributors from Redis.
   */
  private async handleSaveVersion(data: onStatelessPayload): Promise<void> {
    const { connection, document, documentName } = data;
    const context = connection?.context;
    const pageId = getPageId(documentName);
    // Unforgeable: 'agent' only for a signed agent connection, else 'manual'.
    const kind: PageHistoryKind =
      context?.actor === 'agent' ? 'agent' : 'manual';

    // Flush the live ydoc through the normal store path so the page row + ydoc
    // hold exactly what we are about to version (also fires the idle enqueue we
    // supersede below, plus any source-transition boundary). onStoreDocument
    // only needs document/documentName/context.
    await this.onStoreDocument({
      document,
      documentName,
      context,
    } as onStoreDocumentPayload);

    let result:
      | { historyId: string; kind: PageHistoryKind; alreadySaved: boolean }
      | undefined;

    await executeTx(this.db, async (trx) => {
      const page = await this.pageRepo.findById(pageId, {
        withLock: true,
        includeContent: true,
        trx,
      });
      if (!page) return;
      // Never version an effectively-empty page (mirrors the processor's
      // first-history guard); there is nothing intentional to pin.
      if (isEmptyParagraphDoc(page.content as any)) return;

      const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
        page.id,
        { includeContent: true, trx },
      );

      if (
        lastHistory &&
        isDeepStrictEqual(lastHistory.content, page.content)
      ) {
        // Content is already snapshotted. Promote-not-dup.
        if (lastHistory.kind === 'manual') {
          result = {
            historyId: lastHistory.id,
            kind: 'manual',
            alreadySaved: true,
          };
          return;
        }
        await this.pageHistoryRepo.updateHistoryKind(
          lastHistory.id,
          kind,
          trx,
        );
        result = { historyId: lastHistory.id, kind, alreadySaved: false };
        return;
      }

      // Fresh version row. Pop the contributors aggregated since the last
      // snapshot (SPOP); restore them if the write fails so they aren't lost.
      const contributorIds = await this.collabHistory.popContributors(page.id);
      try {
        const saved = await this.pageHistoryRepo.saveHistory(page, {
          contributorIds,
          kind,
          trx,
        });
        result = { historyId: saved.id, kind, alreadySaved: false };
      } catch (err) {
        await this.collabHistory.addContributors(page.id, contributorIds);
        throw err;
      }
    });

    // Housekeeping: this explicit version supersedes the page's pending idle
    // autosnapshot, so cancel it (delayed job → remove() just deletes it) and
    // end the current idle burst so the next edit starts a fresh max-wait window.
    await this.historyQueue.remove(pageId).catch(() => undefined);
    this.idleBurstStart.delete(pageId);

    if (result) {
      document.broadcastStateless(
        JSON.stringify({
          type: 'version.saved',
          historyId: result.historyId,
          kind: result.kind,
          alreadySaved: result.alreadySaved,
        }),
      );
    }
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
    // #370 — trailing idle debounce with a max-wait ceiling. One pending idle
    // job per page (jobId = page.id); on every store we remove the pending
    // delayed job and re-add it, so the snapshot lands `delay` after edits go
    // quiet rather than once per store (precedent: workspace.service.ts).
    // remove() on a delayed job simply deletes it (0 if absent, no throw); if the
    // job is already ACTIVE and the remove is a no-op, the add still de-dups and
    // the processor's isDeepStrictEqual gate collapses the duplicate content.
    //
    // The FIRST arm of a burst records `burstStart`; computeHistoryJob shrinks
    // the delay to the remaining max-wait budget from that point, so a continuous
    // session cannot re-arm the trailing timer forever and starve the snapshot.
    // A burst marker older than the (larger, USER) max-wait means the previous
    // idle job has already fired — start a fresh window instead of firing
    // immediately on the next edit.
    const now = Date.now();
    let burstStart = this.idleBurstStart.get(page.id);
    if (burstStart === undefined || now - burstStart >= IDLE_MAX_WAIT_USER) {
      burstStart = now;
      this.idleBurstStart.set(page.id, burstStart);
    }

    const { jobId, delay } = computeHistoryJob(
      page,
      lastUpdatedSource,
      burstStart,
      now,
    );

    await this.historyQueue.remove(jobId).catch(() => undefined);

    await this.historyQueue.add(
      QueueJob.PAGE_HISTORY,
      { pageId: page.id, kind: 'idle' } as IPageHistoryJob,
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
