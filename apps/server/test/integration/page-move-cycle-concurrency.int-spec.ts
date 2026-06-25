import { Kysely } from 'kysely';
import { BadRequestException } from '@nestjs/common';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageService } from '../../src/core/page/services/page.service';
import {
  getTestDb,
  destroyTestDb,
  createWorkspace,
  createSpace,
  createPage,
} from './db';

/**
 * #159 finding #9 — concurrent opposing page moves must not create a cycle.
 *
 * User A drags X under Y while user B simultaneously drags Y under X. Before the
 * fix, the cycle guard (a breadcrumb/ancestor read) and the parent-update write
 * were NOT in a transaction, so both moves ran against a stale snapshot, both
 * passed their cycle check, and both committed -> X.parent=Y AND Y.parent=X: a
 * cycle with no path to root, which breaks the recursive ancestor CTEs and makes
 * both subtrees vanish from the sidebar.
 *
 * The fix wraps the cycle check + update in one READ COMMITTED transaction and
 * locks the two involved rows FOR UPDATE in a canonical (id-sorted) order, then
 * re-runs the cycle check inside the lock. One move wins; the loser sees the
 * committed re-parent and trips the "own subtree" guard.
 *
 * NOTE: this runs against real Postgres in CI (the integration suite). There is
 * no local Postgres in dev, so it is not expected to run locally.
 */
describe('movePage concurrent opposing moves do not create a cycle [integration]', () => {
  let db: Kysely<any>;
  let workspaceId: string;
  let spaceId: string;

  beforeAll(async () => {
    db = getTestDb();
    workspaceId = (await createWorkspace(db)).id;
    spaceId = (await createSpace(db, workspaceId)).id;
  });

  afterAll(async () => {
    await destroyTestDb();
  });

  it('lets exactly one opposing move win and never persists a cycle', async () => {
    // Real collaborators against the test DB. movePage only touches db-backed
    // methods on pageRepo plus the db itself and the event emitter (stubbed).
    const pageRepo = new PageRepo(
      db as any,
      {} as any,
      { emit: () => undefined } as any,
    );
    const svc = new PageService(
      pageRepo as any, // pageRepo
      {} as any, // pagePermissionRepo
      {} as any, // attachmentRepo
      db as any, // db
      {} as any, // storageService
      {} as any, // attachmentQueue
      {} as any, // aiQueue
      {} as any, // generalQueue
      { emit: () => undefined } as any, // eventEmitter
      {} as any, // collaborationGateway
      {} as any, // watcherService
      {} as any, // transclusionService
    );

    // Seed R (root), X and Y as children of R.
    const root = await createPage(db, { workspaceId, spaceId, title: 'R' });
    const pageX = await createPage(db, { workspaceId, spaceId, title: 'X' });
    const pageY = await createPage(db, { workspaceId, spaceId, title: 'Y' });

    // createPage does not set parentPageId; wire X.parent=R and Y.parent=R and
    // give each a valid fractional-index position.
    await db
      .updateTable('pages')
      .set({ parentPageId: root.id, position: 'a0' })
      .where('id', 'in', [pageX.id, pageY.id])
      .execute();

    // The Page snapshots movePage receives (parentPageId must be R so each move
    // is a genuine re-parent rather than a same-parent reorder).
    const movedX = await pageRepo.findById(pageX.id);
    const movedY = await pageRepo.findById(pageY.id);

    // Two opposing moves racing: A moves X under Y, B moves Y under X.
    const results = await Promise.allSettled([
      svc.movePage(
        { pageId: pageX.id, parentPageId: pageY.id, position: 'a1' },
        movedX,
      ),
      svc.movePage(
        { pageId: pageY.id, parentPageId: pageX.id, position: 'a1' },
        movedY,
      ),
    ]);

    // Exactly one fulfilled and one rejected; the rejection is the cycle guard.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = (rejected[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(BadRequestException);
    expect(String(reason?.message)).toContain('own subtree');

    // No cycle persisted: re-fetch X and Y and assert NOT (X->Y AND Y->X).
    const xNow = await pageRepo.findById(pageX.id);
    const yNow = await pageRepo.findById(pageY.id);
    const isCycle =
      xNow.parentPageId === pageY.id && yNow.parentPageId === pageX.id;
    expect(isCycle).toBe(false);

    // Exactly one re-parent took effect: one of X/Y still points at R, the other
    // points at its sibling.
    const xWon = xNow.parentPageId === pageY.id && yNow.parentPageId === root.id;
    const yWon = yNow.parentPageId === pageX.id && xNow.parentPageId === root.id;
    expect(xWon || yWon).toBe(true);
  });
});
