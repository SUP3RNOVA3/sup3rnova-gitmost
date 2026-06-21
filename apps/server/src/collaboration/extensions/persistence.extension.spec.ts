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

    it('seeds + persists when the persisted ydoc lacks a title fragment', async () => {
      const src = TiptapTransformer.toYdoc(bodyJson, 'default', tiptapExtensions);
      const page = {
        id: 'PAGE_ID',
        title: 'Legacy Title',
        ydoc: Buffer.from(Y.encodeStateAsUpdate(src)),
        content: null,
      };
      pageRepo.findById.mockResolvedValue(page);

      const document = { isEmpty: () => true };
      const result = await ext.onLoadDocument({
        documentName: 'page.PAGE_ID',
        document,
      } as any);

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      const call = pageRepo.updatePage.mock.calls[0];
      expect(Buffer.isBuffer(call[0].ydoc)).toBe(true);
      expect(call[1]).toBe('PAGE_ID');
      expect(result).toBeTruthy();
    });

    it('does NOT persist when the ydoc already has a title fragment', async () => {
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

      expect(pageRepo.updatePage).not.toHaveBeenCalled();
      expect(result).toBeTruthy();
    });

    it('converts legacy content -> ydoc and persists the built doc', async () => {
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

      expect(pageRepo.updatePage).toHaveBeenCalledTimes(1);
      expect(result).toBeTruthy();
    });
  });
});
