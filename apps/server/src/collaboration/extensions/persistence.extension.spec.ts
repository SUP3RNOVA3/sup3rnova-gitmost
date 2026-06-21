import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { PersistenceExtension } from './persistence.extension';
import { buildTitleSeedYdoc, tiptapExtensions } from '../collaboration.util';

// Direct instantiation with stub deps, mirroring the auth/env unit specs.
const bodyJson = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
};

// Build a body Y.Doc with a known JSON, plus a monkey-patched broadcastStateless
// (the real Hocuspocus Document supplies it; a bare Y.Doc does not).
const buildDoc = () => {
  const d: any = TiptapTransformer.toYdoc(bodyJson, 'default', tiptapExtensions);
  d.broadcastStateless = jest.fn();
  return d;
};

const cloneOut = (doc: any) =>
  JSON.parse(JSON.stringify(TiptapTransformer.fromYdoc(doc, 'default')));

const addTitleFragment = (doc: any, title: string) =>
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(buildTitleSeedYdoc(title)));

describe('PersistenceExtension', () => {
  let pageRepo: any;
  let pageHistoryRepo: any;
  let trx: any;
  let db: any;
  let aiQueue: any;
  let historyQueue: any;
  let notificationQueue: any;
  let collabHistory: any;
  let transclusionService: any;
  let ext: PersistenceExtension;

  beforeEach(() => {
    pageRepo = {
      findById: jest.fn(),
      updatePage: jest.fn().mockResolvedValue(undefined),
    };
    pageHistoryRepo = {
      findPageLastHistory: jest.fn(),
      saveHistory: jest.fn(),
    };
    trx = {};
    db = { transaction: () => ({ execute: (fn: any) => fn(trx) }) };
    aiQueue = { add: jest.fn().mockResolvedValue(undefined) };
    historyQueue = { add: jest.fn().mockResolvedValue(undefined) };
    notificationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    collabHistory = { addContributors: jest.fn().mockResolvedValue(undefined) };
    transclusionService = {
      syncPageTransclusions: jest.fn().mockResolvedValue(undefined),
      syncPageReferences: jest.fn().mockResolvedValue(undefined),
      syncPageTemplateReferences: jest.fn().mockResolvedValue(undefined),
    };

    ext = new PersistenceExtension(
      pageRepo as any,
      pageHistoryRepo as any,
      db as any,
      aiQueue as any,
      historyQueue as any,
      notificationQueue as any,
      collabHistory as any,
      transclusionService as any,
    );
  });

  describe('seedTitleFragment', () => {
    it('returns false for empty/whitespace/null titles', () => {
      const doc = new Y.Doc();
      expect((ext as any).seedTitleFragment(doc, '')).toBe(false);
      expect((ext as any).seedTitleFragment(doc, '   ')).toBe(false);
      expect((ext as any).seedTitleFragment(doc, null)).toBe(false);
    });

    it('does NOT re-seed an existing non-empty title fragment', () => {
      const doc = new Y.Doc();
      addTitleFragment(doc, 'Existing');

      expect((ext as any).seedTitleFragment(doc, 'Other')).toBe(false);

      const text = TiptapTransformer.fromYdoc(doc, 'title');
      expect(JSON.stringify(text)).toContain('Existing');
      expect(JSON.stringify(text)).not.toContain('Other');
    });

    it('seeds an empty fragment from a non-empty title and returns true', () => {
      const doc = new Y.Doc();
      expect((ext as any).seedTitleFragment(doc, 'Hello')).toBe(true);

      const json: any = TiptapTransformer.fromYdoc(doc, 'title');
      expect(JSON.stringify(json)).toContain('Hello');
    });

    it('returns false (defensive) when reading the fragment throws', () => {
      const fakeDoc = {
        get: () => {
          throw new Error('boom');
        },
      };
      expect((ext as any).seedTitleFragment(fakeDoc as any, 'X')).toBe(false);
    });
  });

  describe('onStoreDocument', () => {
    const basePage = (overrides: any) => ({
      id: 'PAGE_ID',
      slugId: 'slug',
      spaceId: 'space',
      parentPageId: null,
      creatorId: 'creator',
      contributorIds: ['creator'],
      workspaceId: 'ws',
      title: 'whatever',
      content: null,
      lastUpdatedSource: 'user',
      createdAt: new Date().toISOString(),
      ...overrides,
    });

    const context = { user: { id: 'u1', name: 'U', avatarUrl: null } };

    it('no-op when neither body nor title changed', async () => {
      const document = buildDoc();
      const page = basePage({
        content: cloneOut(document),
        title: 'hello title',
      });
      pageRepo.findById.mockResolvedValue(page);

      await ext.onStoreDocument({
        documentName: 'page.PAGE_ID',
        document,
        context,
      } as any);

      expect(pageRepo.updatePage).not.toHaveBeenCalled();
      expect(document.broadcastStateless).not.toHaveBeenCalled();
      expect(collabHistory.addContributors).not.toHaveBeenCalled();
      expect(transclusionService.syncPageTransclusions).not.toHaveBeenCalled();
      expect(aiQueue.add).not.toHaveBeenCalled();
      expect(historyQueue.add).not.toHaveBeenCalled();
    });

    it('title-only change persists the title without body side-effects', async () => {
      const document = buildDoc();
      addTitleFragment(document, 'New Title');
      const page = basePage({
        content: cloneOut(document),
        title: 'Old Title',
      });
      pageRepo.findById.mockResolvedValue(page);

      await ext.onStoreDocument({
        documentName: 'page.PAGE_ID',
        document,
        context,
      } as any);

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      const call = pageRepo.updatePage.mock.calls[0];
      expect(call[0].title).toBe('New Title');
      expect(call[0].ydoc).toBeDefined();
      expect(call[0].contributorIds).toBeDefined();
      expect('content' in call[0]).toBe(false);
      // Title-only must not touch the body-authorship provenance.
      expect('lastUpdatedSource' in call[0]).toBe(false);
      expect(call[1]).toBe('PAGE_ID');
      expect(call[3].treeUpdate.title).toBe('New Title');

      expect(collabHistory.addContributors).toHaveBeenCalledTimes(1);
      expect(collabHistory.addContributors).toHaveBeenCalledWith(
        'PAGE_ID',
        expect.any(Array),
      );
      expect(document.broadcastStateless).toHaveBeenCalledTimes(1);
      expect(transclusionService.syncPageTransclusions).not.toHaveBeenCalled();
      expect(aiQueue.add).not.toHaveBeenCalled();
      expect(historyQueue.add).not.toHaveBeenCalled();
    });

    it('an EMPTY title fragment does NOT overwrite a non-empty page.title (anti-corruption guard, Bug 2)', async () => {
      // The client can momentarily seed the 'title' fragment as an EMPTY heading
      // (hasTitleFragment true, extracted text '') before the real title syncs.
      // Body is unchanged here, so the only candidate write is the title -> the
      // guard must turn this into a full no-op (no updatePage, no broadcast).
      const document = buildDoc();
      addTitleFragment(document, ''); // empty heading: length > 0 but text ''
      const page = basePage({
        content: cloneOut(document),
        title: 'Real Title',
      });
      pageRepo.findById.mockResolvedValue(page);

      await ext.onStoreDocument({
        documentName: 'page.PAGE_ID',
        document,
        context,
      } as any);

      // No write at all: the empty title is not authoritative and the body is
      // unchanged, so onStoreDocument must take the no-op fast path.
      expect(pageRepo.updatePage).not.toHaveBeenCalled();
      expect(document.broadcastStateless).not.toHaveBeenCalled();
    });

    it('an EMPTY title fragment alongside a body change persists the body but NOT an empty title (anti-corruption guard, Bug 2)', async () => {
      const document = buildDoc();
      addTitleFragment(document, ''); // empty title fragment
      const page = basePage({
        content: { type: 'doc', content: [] }, // different body -> bodyChanged
        title: 'Real Title',
      });
      pageRepo.findById.mockResolvedValue(page);

      await ext.onStoreDocument({
        documentName: 'page.PAGE_ID',
        document,
        context,
      } as any);

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      const call = pageRepo.updatePage.mock.calls[0];
      // Body is persisted, but the title is NOT included (empty == not
      // authoritative) and no tree update is broadcast for the title.
      expect(call[0].content).toBeTruthy();
      expect('title' in call[0]).toBe(false);
      expect(call[3]).toBeUndefined();
    });

    it('body + title change persists both with full body side-effects', async () => {
      const document = buildDoc();
      addTitleFragment(document, 'New Title');
      const page = basePage({
        content: { type: 'doc', content: [] },
        title: 'Old Title',
      });
      pageRepo.findById.mockResolvedValue(page);

      await ext.onStoreDocument({
        documentName: 'page.PAGE_ID',
        document,
        context,
      } as any);

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      const call = pageRepo.updatePage.mock.calls[0];
      expect(call[0].content).toBeTruthy();
      expect(call[0].title).toBe('New Title');
      expect(call[0].ydoc).toBeDefined();
      expect(call[0].lastUpdatedSource).toBe('user');
      expect(call[3].treeUpdate).toBeDefined();

      expect(transclusionService.syncPageTransclusions).toHaveBeenCalled();
      expect(aiQueue.add).toHaveBeenCalled();
      expect(historyQueue.add).toHaveBeenCalled();
      expect(collabHistory.addContributors).toHaveBeenCalled();
      expect(document.broadcastStateless).toHaveBeenCalled();
    });

    it('body-only change persists the body without a tree update', async () => {
      const document = buildDoc();
      const page = basePage({
        content: { type: 'doc', content: [] },
        title: 'whatever',
      });
      pageRepo.findById.mockResolvedValue(page);

      await ext.onStoreDocument({
        documentName: 'page.PAGE_ID',
        document,
        context,
      } as any);

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      const call = pageRepo.updatePage.mock.calls[0];
      expect(call[0].content).toBeTruthy();
      expect('title' in call[0]).toBe(false);
      // No treeUpdate for a body-only save.
      expect(call[3]).toBeUndefined();

      expect(transclusionService.syncPageTransclusions).toHaveBeenCalled();
      expect(aiQueue.add).toHaveBeenCalled();
      expect(historyQueue.add).toHaveBeenCalled();
      expect(document.broadcastStateless).toHaveBeenCalled();
    });
  });

  describe('onLoadDocument', () => {
    it('returns early (no DB read) when the document is not empty', async () => {
      const document = { isEmpty: () => false };
      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      expect(result).toBeUndefined();
      expect(pageRepo.findById).not.toHaveBeenCalled();
    });

    it('returns undefined and does not persist when the page is null', async () => {
      const document = { isEmpty: () => true };
      pageRepo.findById.mockResolvedValue(null);

      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      expect(result).toBeUndefined();
      expect(pageRepo.updatePage).not.toHaveBeenCalled();
    });

    it('seeds + persists under a lock when the persisted ydoc lacks a title fragment', async () => {
      const src = TiptapTransformer.toYdoc(bodyJson, 'default', tiptapExtensions);
      const page = {
        id: 'PAGE_ID',
        title: 'Legacy Title',
        ydoc: Buffer.from(Y.encodeStateAsUpdate(src)),
        content: null,
      };
      // Both the cheap pre-check and the locked re-read return the same row.
      pageRepo.findById.mockResolvedValue(page);

      const document = { isEmpty: () => true };
      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      // The locked re-read must take the row lock inside the tx.
      const lockedReadCall = pageRepo.findById.mock.calls.find(
        (c: any[]) => c[1]?.withLock,
      );
      expect(lockedReadCall).toBeDefined();
      expect(lockedReadCall[1].trx).toBe(trx);

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      const call = pageRepo.updatePage.mock.calls[0];
      expect(Buffer.isBuffer(call[0].ydoc)).toBe(true);
      expect(call[1]).toBe('PAGE_ID');
      // Persist must run inside the transaction.
      expect(call[2]).toBe(trx);
      expect(result).toBeTruthy();
    });

    it('does NOT lock or persist when the ydoc already has a title fragment', async () => {
      const src = TiptapTransformer.toYdoc(bodyJson, 'default', tiptapExtensions);
      Y.applyUpdate(src, Y.encodeStateAsUpdate(buildTitleSeedYdoc('Has Title')));
      const page = {
        id: 'PAGE_ID',
        title: 'Has Title',
        ydoc: Buffer.from(Y.encodeStateAsUpdate(src)),
        content: null,
      };
      pageRepo.findById.mockResolvedValue(page);

      const document = { isEmpty: () => true };
      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      // Hot path: only the cheap lock-free read, no locked re-read, no write.
      expect(pageRepo.findById).toHaveBeenCalledTimes(1);
      expect(pageRepo.findById.mock.calls[0][1]?.withLock).toBeFalsy();
      expect(pageRepo.updatePage).not.toHaveBeenCalled();
      expect(result).toBeTruthy();
    });

    it('converts legacy content -> ydoc inside a tx and persists a {ydoc} Buffer', async () => {
      const page = {
        id: 'PAGE_ID',
        title: 'T',
        ydoc: null,
        content: bodyJson,
      };
      pageRepo.findById.mockResolvedValue(page);

      const document = { isEmpty: () => true };
      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      const lockedReadCall = pageRepo.findById.mock.calls.find(
        (c: any[]) => c[1]?.withLock,
      );
      expect(lockedReadCall).toBeDefined();
      expect(lockedReadCall[1].trx).toBe(trx);

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      const call = pageRepo.updatePage.mock.calls[0];
      expect(Buffer.isBuffer(call[0].ydoc)).toBe(true);
      expect(call[2]).toBe(trx);
      // The rebuilt doc carries the body.
      expect(JSON.stringify(cloneOut(result))).toContain('hello');
    });

    it('SKIPS rebuild when the locked re-read shows the ydoc was already healed', async () => {
      // Simulate a concurrent process: the cheap pre-check sees ydoc=null (legacy
      // rebuild path), but by the time we hold the lock another process has
      // already persisted a healthy ydoc. We must adopt it, not rebuild/clobber.
      const healed = TiptapTransformer.toYdoc(
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'healed' }] }] },
        'default',
        tiptapExtensions,
      );
      Y.applyUpdate(healed, Y.encodeStateAsUpdate(buildTitleSeedYdoc('Healed Title')));
      const healedYdoc = Buffer.from(Y.encodeStateAsUpdate(healed));

      const preCheck = { id: 'PAGE_ID', title: 'T', ydoc: null, content: bodyJson };
      const lockedRow = {
        id: 'PAGE_ID',
        title: 'Healed Title',
        ydoc: healedYdoc,
        content: bodyJson,
      };
      pageRepo.findById
        .mockResolvedValueOnce(preCheck) // cheap pre-check
        .mockResolvedValueOnce(lockedRow); // locked re-read

      const document = { isEmpty: () => true };
      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      // The healthy ydoc had a title fragment already, so nothing was rebuilt or
      // seeded -> no clobbering write.
      expect(pageRepo.updatePage).not.toHaveBeenCalled();
      // The returned doc is the healed body, NOT a fresh rebuild of bodyJson.
      expect(JSON.stringify(cloneOut(result))).toContain('healed');
    });

    it('REJECTS the load when the rebuild persist fails (does not return an unpersisted doc)', async () => {
      const page = { id: 'PAGE_ID', title: 'T', ydoc: null, content: bodyJson };
      pageRepo.findById.mockResolvedValue(page);
      pageRepo.updatePage.mockRejectedValue(new Error('db down'));
      const errSpy = jest
        .spyOn((ext as any).logger, 'error')
        .mockImplementation(() => undefined);

      const document = { isEmpty: () => true };
      await expect(
        ext.onLoadDocument({
          documentName: 'page.PAGE_ID',
          document,
        } as any),
      ).rejects.toThrow('db down');
      expect(errSpy).toHaveBeenCalled();
    });

    it('seed-only persist FAILURE returns the doc from the existing ydoc (no throw)', async () => {
      const src = TiptapTransformer.toYdoc(bodyJson, 'default', tiptapExtensions);
      const page = {
        id: 'PAGE_ID',
        title: 'Legacy Title',
        ydoc: Buffer.from(Y.encodeStateAsUpdate(src)),
        content: null,
      };
      pageRepo.findById.mockResolvedValue(page);
      pageRepo.updatePage.mockRejectedValue(new Error('db down'));
      const errSpy = jest
        .spyOn((ext as any).logger, 'error')
        .mockImplementation(() => undefined);

      const document = { isEmpty: () => true };
      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      // Non-fatal: we fall back to the doc loaded from the existing page.ydoc.
      expect(result).toBeTruthy();
      expect(JSON.stringify(cloneOut(result))).toContain('hello');
      expect(errSpy).toHaveBeenCalled();
    });
  });
});
