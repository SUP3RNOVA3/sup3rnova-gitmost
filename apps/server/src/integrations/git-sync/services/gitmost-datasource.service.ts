import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import {
  type GitSyncClient,
  type GitSyncPageNodeLite,
  parseDocmostMarkdown,
  markdownToProseMirror,
} from '@docmost/git-sync';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { SpaceRepo } from '@docmost/db/repos/space/space.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageService } from '../../../core/page/services/page.service';
import { CollaborationGateway } from '../../../collaboration/collaboration.gateway';
import { tiptapExtensions } from '../../../collaboration/collaboration.util';
import { mergeXmlFragments, mergeXmlFragments3Way } from './yjs-body-merge';
import { AuthProvenanceData } from '../../../common/decorators/auth-provenance.decorator';

/**
 * The acting context the orchestrator binds the datasource to. The datasource is
 * NOT a fixed-identity singleton: it operates on behalf of a (workspaceId,
 * userId) pair the orchestrator supplies per space (plan §3.2). `userId` is the
 * git-sync service user — it stays the responsible author (creatorId /
 * lastUpdatedById) while the `'git-sync'` actor marks provenance (plan §8.1).
 */
export interface GitSyncBindContext {
  workspaceId: string;
  userId: string;
}

/**
 * The git-sync provenance carried into PageService writes. PageService.create/
 * update/movePage honor this provenance and stamp `lastUpdatedSource = 'git-sync'`
 * on the page row when `provenance.actor === 'git-sync'`. Body writes (writeBody,
 * §3.3) likewise stamp 'git-sync' because the collab context's `actor: 'git-sync'`
 * flows into PersistenceExtension. So ALL git-sync structural + body writes mark
 * the row's source, which the listener's loop-guard reads to skip our own writes.
 */
const GIT_SYNC_PROVENANCE: AuthProvenanceData = {
  actor: 'git-sync',
  aiChatId: null,
};

/**
 * Native, in-process implementation of the engine's `GitSyncClient` seam
 * (plan §3). Reads go through repositories (PageRepo/SpaceRepo); body writes go
 * through collab `openDirectConnection` (§3.3); structural mutations
 * (create/move/delete/rename) go through PageService.
 *
 * Shape: this is an `@Injectable()` holding the repos/services. The orchestrator
 * calls `bind({ workspaceId, userId })` to obtain a `GitSyncClient` bound to that
 * acting context. The bound object is a thin closure over `this` — no per-call
 * identity plumbing leaks into the engine.
 */
@Injectable()
export class GitmostDataSourceService {
  private readonly logger = new Logger(GitmostDataSourceService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly spaceRepo: SpaceRepo,
    private readonly pageService: PageService,
    private readonly collabGateway: CollaborationGateway,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * Bind the datasource to an acting (workspaceId, userId) context and return a
   * `GitSyncClient` the engine can consume directly.
   */
  bind(ctx: GitSyncBindContext): GitSyncClient {
    return {
      listSpaceTree: (spaceId, rootPageId) =>
        this.listSpaceTree(ctx, spaceId, rootPageId),
      getPageJson: (pageId) => this.getPageJson(ctx, pageId),
      importPageMarkdown: (pageId, fullMarkdown, baseMarkdown) =>
        this.importPageMarkdown(ctx, pageId, fullMarkdown, baseMarkdown),
      createPage: (title, content, spaceId, parentPageId) =>
        this.createPage(ctx, title, content, spaceId, parentPageId),
      deletePage: (pageId) => this.deletePage(ctx, pageId),
      movePage: (pageId, parentPageId, position) =>
        this.movePage(pageId, parentPageId, position),
      renamePage: (pageId, title) => this.renamePage(ctx, pageId, title),
      listRecentSince: (spaceId, sinceIso, hardPageCap) =>
        this.listRecentSince(spaceId, sinceIso, hardPageCap),
      listTrash: (spaceId) => this.listTrash(spaceId),
      restorePage: (pageId) => this.restorePage(ctx, pageId),
    };
  }

  // --- reads (pull) ---------------------------------------------------------

  /**
   * Full page tree of a space mapped to the engine's `PageNode` shape. We read
   * the DB directly, so `complete` is ALWAYS `true` — the incomplete-fetch
   * suppression (SPEC §8) never fires natively (plan §3.2).
   */
  private async listSpaceTree(
    ctx: GitSyncBindContext,
    spaceId: string,
    _rootPageId?: string,
  ): Promise<{ pages: GitSyncPageNodeLite[]; complete: boolean }> {
    const space = await this.spaceRepo.findById(spaceId, ctx.workspaceId);
    if (!space) {
      throw new NotFoundException(`Space ${spaceId} not found`);
    }

    const rows = await this.pageRepo.getSpaceDescendants(space.id, {
      includeContent: false,
    });

    // `getSpaceDescendants` does not select `hasChildren`; derive it from the
    // parent links present in the same result set.
    const parentIds = new Set<string>();
    for (const row of rows) {
      if (row.parentPageId) parentIds.add(row.parentPageId);
    }

    const pages: GitSyncPageNodeLite[] = rows.map((row) => ({
      id: row.id,
      slugId: row.slugId,
      title: row.title,
      parentPageId: row.parentPageId ?? null,
      hasChildren: parentIds.has(row.id),
      position: row.position,
    }));

    return { pages, complete: true };
  }

  /**
   * One page WITH its ProseMirror body content (editor-ext schema). `updatedAt`
   * is serialized to an ISO string for the loop-guard.
   */
  private async getPageJson(
    ctx: GitSyncBindContext,
    pageId: string,
  ): Promise<{
    id: string;
    slugId: string;
    title: string;
    parentPageId: string | null;
    spaceId: string;
    updatedAt: string;
    content: unknown;
  }> {
    const page = await this.pageRepo.findById(pageId, { includeContent: true });
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    return {
      id: page.id,
      slugId: page.slugId,
      title: page.title,
      parentPageId: page.parentPageId ?? null,
      spaceId: page.spaceId,
      updatedAt: new Date(page.updatedAt).toISOString(),
      content: page.content,
    };
  }

  // --- writes (push) --------------------------------------------------------

  /**
   * Merge a page's body from a self-contained markdown file: parse the meta+body
   * envelope, convert the body to ProseMirror, then merge it through collab
   * (§3.3). When `baseMarkdown` (the last-synced version of the file) is given,
   * the body write is a THREE-WAY merge against the live doc so concurrent human
   * edits survive (review #5); without it, a 2-way merge. Returns the fresh
   * page's `updatedAt` for the loop-guard.
   */
  private async importPageMarkdown(
    ctx: GitSyncBindContext,
    pageId: string,
    fullMarkdown: string,
    baseMarkdown?: string | null,
  ): Promise<{ updatedAt?: string }> {
    const { body } = parseDocmostMarkdown(fullMarkdown);
    const doc = await markdownToProseMirror(body);

    let baseDoc: unknown;
    if (baseMarkdown != null) {
      const { body: baseBody } = parseDocmostMarkdown(baseMarkdown);
      baseDoc = await markdownToProseMirror(baseBody);
    }

    await this.writeBody(pageId, doc, ctx.userId, baseDoc);

    const page = await this.pageRepo.findById(pageId);
    return {
      updatedAt: page ? new Date(page.updatedAt).toISOString() : undefined,
    };
  }

  /**
   * Create a page shell via PageService, then write its body through collab.
   * Returns the assigned id (`data.id`) + the page's `updatedAt`.
   */
  private async createPage(
    ctx: GitSyncBindContext,
    title: string,
    content: string,
    spaceId: string,
    parentPageId?: string,
  ): Promise<{ data: { id: string }; updatedAt?: string }> {
    const page = await this.pageService.create(
      ctx.userId,
      ctx.workspaceId,
      { spaceId, title, parentPageId },
      GIT_SYNC_PROVENANCE,
    );

    // The shell is created without body; push the markdown body through collab.
    const { body } = parseDocmostMarkdown(content);
    const doc = await markdownToProseMirror(body);
    await this.writeBody(page.id, doc, ctx.userId);

    const fresh = await this.pageRepo.findById(page.id);
    return {
      data: { id: page.id },
      updatedAt: fresh ? new Date(fresh.updatedAt).toISOString() : undefined,
    };
  }

  /**
   * Soft-delete the page to Trash (reversible). NOT a force delete — `restorePage`
   * can bring it back.
   */
  private async deletePage(
    ctx: GitSyncBindContext,
    pageId: string,
  ): Promise<unknown> {
    await this.pageService.removePage(pageId, ctx.userId, ctx.workspaceId);
    return { id: pageId };
  }

  /**
   * Reparent a page. Docmost-move REQUIRES a fractional-index `position`; when the
   * engine omits it, compute a key after the destination's last sibling (plan
   * §3.2 / §14.4).
   */
  private async movePage(
    pageId: string,
    parentPageId: string | null,
    position?: string,
  ): Promise<unknown> {
    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }

    const resolvedPosition =
      position ?? (await this.computeMovePosition(page.spaceId, parentPageId));

    await this.pageService.movePage(
      { pageId, parentPageId: parentPageId ?? null, position: resolvedPosition },
      page,
      GIT_SYNC_PROVENANCE,
    );
    return { id: pageId };
  }

  /**
   * Compute a fractional-index position AFTER the last sibling under
   * `parentPageId` (root pages when null) in the space, ordered by `position`
   * with the "C" collation Docmost uses (plan §14.4). Falls back to a fresh key
   * when there are no siblings.
   */
  private async computeMovePosition(
    spaceId: string,
    parentPageId: string | null,
  ): Promise<string> {
    let query = this.db
      .selectFrom('pages')
      .select(['position'])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is', null)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(1);

    query = parentPageId
      ? query.where('parentPageId', '=', parentPageId)
      : query.where('parentPageId', 'is', null);

    const lastSibling = await query.executeTakeFirst();
    return generateJitteredKeyBetween(lastSibling?.position ?? null, null);
  }

  /** Change a page's title only (no body touch). */
  private async renamePage(
    ctx: GitSyncBindContext,
    pageId: string,
    title: string,
  ): Promise<unknown> {
    const page = await this.pageRepo.findById(pageId);
    if (!page) {
      throw new NotFoundException(`Page ${pageId} not found`);
    }
    // PageService.update takes a User; the git-sync service user is the
    // responsible author. Only the id is read off it for lastUpdatedById.
    // `pageId` satisfies the UpdatePageDto type; PageService.update reads the
    // page id off `page`, not the DTO. Only `title` is applied here.
    await this.pageService.update(
      page,
      { pageId, title },
      { id: ctx.userId } as any,
      GIT_SYNC_PROVENANCE,
    );
    return { id: pageId };
  }

  // --- continuous (phase B+) ------------------------------------------------

  /**
   * Pages in the space updated since `sinceIso` (poll-safety reconciliation,
   * SPEC §8). `spaceId` undefined widens to all spaces; `hardPageCap` bounds the
   * result. Reads the DB directly (no cursor pagination needed here).
   */
  private async listRecentSince(
    spaceId: string | undefined,
    sinceIso: string | null,
    hardPageCap?: number,
  ): Promise<unknown[]> {
    let query = this.db
      .selectFrom('pages')
      .select([
        'id',
        'slugId',
        'title',
        'parentPageId',
        'spaceId',
        'updatedAt',
      ])
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc');

    if (spaceId) query = query.where('spaceId', '=', spaceId);
    if (sinceIso) query = query.where('updatedAt', '>', new Date(sinceIso));
    if (hardPageCap) query = query.limit(hardPageCap);

    const rows = await query.execute();
    return rows.map((row) => ({
      ...row,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  }

  /** Soft-deleted (trashed) pages for the space (deletion detection). */
  private async listTrash(spaceId: string): Promise<unknown[]> {
    const rows = await this.db
      .selectFrom('pages')
      .select(['id', 'slugId', 'title', 'parentPageId', 'spaceId', 'deletedAt'])
      .where('spaceId', '=', spaceId)
      .where('deletedAt', 'is not', null)
      .orderBy('deletedAt', 'desc')
      .execute();

    return rows.map((row) => ({
      ...row,
      deletedAt: row.deletedAt ? new Date(row.deletedAt).toISOString() : null,
    }));
  }

  /** Restore a soft-deleted page from Trash. */
  private async restorePage(
    ctx: GitSyncBindContext,
    pageId: string,
  ): Promise<unknown> {
    await this.pageRepo.restorePage(pageId, ctx.workspaceId);
    return { id: pageId };
  }

  // --- linchpin: native body write (§3.3) -----------------------------------

  /**
   * In-process body write — no loopback websocket, no service-user token. Mirrors
   * the collab handler's 'replace' operation exactly: open a direct connection,
   * drop the existing fragment, apply the converted doc, then disconnect.
   *
   * The `{ actor: 'git-sync', user: { id: userId } }` context flows into
   * PersistenceExtension.onStoreDocument, which persists ydoc+content+textContent,
   * stamps `lastUpdatedSource = 'git-sync'`, and broadcasts `page.updated`. The
   * service user (`user.id`) stays the responsible `lastUpdatedById`; the actor
   * marks provenance (plan §8.1).
   */
  private async writeBody(
    pageId: string,
    prosemirrorJson: unknown,
    userId: string,
    baseProsemirrorJson?: unknown,
  ): Promise<void> {
    const documentName = `page.${pageId}`;

    // Build the incoming (and base) Yjs docs BEFORE opening the connection /
    // touching the live doc. If a transform throws (a malformed/unsupported doc)
    // we must NOT have mutated the live body — otherwise a conversion failure
    // could leave the page empty (review #5 — crash-safe conversion).
    const targetDoc = TiptapTransformer.toYdoc(
      prosemirrorJson,
      'default',
      tiptapExtensions,
    );
    const baseDoc =
      baseProsemirrorJson != null
        ? TiptapTransformer.toYdoc(baseProsemirrorJson, 'default', tiptapExtensions)
        : null;

    const conn = await this.collabGateway.openDirectConnection(documentName, {
      actor: 'git-sync',
      // PersistenceExtension reads `context.user.id` for lastUpdatedById, so the
      // service user is required on the context (unlike the bare `{ actor }`
      // sketch in the plan).
      user: { id: userId },
    });
    try {
      await conn.transact((doc) => {
        const liveFrag = doc.getXmlFragment('default');
        const targetFrag = targetDoc.getXmlFragment('default');
        // Block-level MERGE rather than a full-body replace (review #5): diff the
        // live body against the incoming git body and apply only the blocks that
        // actually changed; concurrently-edited blocks are left untouched and an
        // unchanged resync is a 0-op write. With a `base` (the last-synced
        // version) do a THREE-WAY merge so a block ONLY the human changed is kept
        // and a block ONLY git changed is taken (conflicts -> git). Without a base
        // (e.g. createPage), fall back to the 2-way merge.
        if (baseDoc) {
          mergeXmlFragments3Way(
            liveFrag,
            targetFrag,
            baseDoc.getXmlFragment('default'),
          );
        } else {
          mergeXmlFragments(liveFrag, targetFrag);
        }
      });
    } finally {
      await conn.disconnect();
    }
  }
}
