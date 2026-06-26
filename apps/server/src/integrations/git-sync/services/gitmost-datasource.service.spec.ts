// Stub the collab util so importing the service does not drag in the
// editor-ext -> @tiptap/react -> react-dom graph (unloadable under jest's node
// env, same coupling noted in mcp.service.spec.ts). The captured transact
// callback is never executed in these unit tests, so the stub extensions array
// is sufficient; the real collab write path is exercised by integration tests.
jest.mock('../../../collaboration/collaboration.util', () => ({
  tiptapExtensions: [],
  getPageId: (name: string) => name.replace(/^page\./, ''),
}));
// writeBody now builds the replacement Yjs state eagerly (before clearing the
// live doc), so TiptapTransformer.toYdoc runs in these unit tests. Real Tiptap
// extensions are stubbed to [] above (they drag in the React graph), which can't
// build a schema — so stub the transformer to return a small non-empty Y.Doc.
// The real conversion is exercised by the @docmost/git-sync converter tests and
// the integration tests.
jest.mock('@hocuspocus/transformer', () => {
  const Yjs = require('yjs');
  return {
    TiptapTransformer: {
      toYdoc: jest.fn(() => {
        const d = new Yjs.Doc();
        d.getXmlFragment('default').insert(0, [new Yjs.XmlElement('paragraph')]);
        return d;
      }),
    },
  };
});
// PageService is only ever a mocked dependency here; stub the editor-ext entry
// it imports so loading its module does not pull in the React graph either.
jest.mock('@docmost/editor-ext', () => ({
  markdownToHtml: jest.fn(),
}));
// The service loads `parseDocmostMarkdown` / `markdownToProseMirror` at runtime
// via the `loadGitSync()` bridge (the ESM `@docmost/git-sync` package cannot be
// `require()`d under jest). Stub the loader: the real conversion is exercised by
// the @docmost/git-sync converter tests and the converter gate; here the mocked
// TiptapTransformer.toYdoc ignores the converted doc anyway, so a passthrough
// body + a minimal ProseMirror doc is sufficient.
jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    parseDocmostMarkdown: (md: string) => ({ meta: {}, body: md }),
    markdownToProseMirror: async () => ({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    }),
  })),
}));

import * as Y from 'yjs';
import { GitmostDataSourceService } from './gitmost-datasource.service';
// The body-write seam picks 2-way vs 3-way merge based on whether a base doc was
// built. We spy on the real module exports (ts-jest CJS output references them
// through the namespace object, so the spies intercept the SUT's calls) and let
// them call through, so we assert WHICH merge ran without mocking the behaviour.
import * as bodyMerge from './yjs-body-merge';

// Focused unit/contract test for the native GitSyncClient adapter.
// No DB, no real collab server: the repos/services/gateway are mocked and we
// assert the mapping logic + the provenance/soft-delete/position contracts.

type AnyMock = jest.Mock;

interface Mocks {
  pageRepo: {
    findById: AnyMock;
    getSpaceDescendants: AnyMock;
    restorePage: AnyMock;
  };
  spaceRepo: { findById: AnyMock };
  pageService: {
    create: AnyMock;
    update: AnyMock;
    movePage: AnyMock;
    removePage: AnyMock;
  };
  collabGateway: { openDirectConnection: AnyMock };
  // Minimal Kysely-ish chainable mock for the direct-query paths.
  db: any;
  // Captured collab connection (the fake conn the gateway returns).
  conn: {
    transact: AnyMock;
    disconnect: AnyMock;
    context?: any;
    capturedFn?: (doc: any) => void;
  };
}

function makeQueryBuilder(rows: any[]) {
  const qb: any = {};
  for (const m of ['select', 'where', 'orderBy', 'limit']) {
    qb[m] = jest.fn(() => qb);
  }
  qb.execute = jest.fn(async () => rows);
  qb.executeTakeFirst = jest.fn(async () => rows[0]);
  return qb;
}

function build(rows: any[] = []): {
  service: GitmostDataSourceService;
  mocks: Mocks;
} {
  const conn: Mocks['conn'] = {
    transact: jest.fn(async (fn: (doc: any) => void) => {
      conn.capturedFn = fn;
    }),
    disconnect: jest.fn(async () => undefined),
  };

  const mocks: Mocks = {
    pageRepo: {
      findById: jest.fn(),
      getSpaceDescendants: jest.fn(),
      restorePage: jest.fn(async () => undefined),
    },
    spaceRepo: { findById: jest.fn(async () => ({ id: 'space-1' })) },
    pageService: {
      create: jest.fn(),
      update: jest.fn(async () => undefined),
      movePage: jest.fn(async () => undefined),
      removePage: jest.fn(async () => undefined),
    },
    collabGateway: {
      openDirectConnection: jest.fn(async (_name: string, ctx: any) => {
        conn.context = ctx;
        return conn;
      }),
    },
    db: {
      selectFrom: jest.fn(() => makeQueryBuilder(rows)),
    },
    conn,
  };

  const service = new GitmostDataSourceService(
    mocks.pageRepo as any,
    mocks.spaceRepo as any,
    mocks.pageService as any,
    mocks.collabGateway as any,
    mocks.db as any,
  );

  return { service, mocks };
}

const CTX = { workspaceId: 'ws-1', userId: 'svc-user' };

describe('GitmostDataSourceService', () => {
  describe('listSpaceTree', () => {
    it('maps descendants to PageNode and is always complete:true', async () => {
      const { service, mocks } = build();
      mocks.spaceRepo.findById.mockResolvedValue({ id: 'space-1' });
      mocks.pageRepo.getSpaceDescendants.mockResolvedValue([
        {
          id: 'p1',
          slugId: 's1',
          title: 'Root',
          parentPageId: null,
          position: 'a0',
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'Child',
          parentPageId: 'p1',
          position: 'a1',
        },
      ]);

      const client = service.bind(CTX);
      const res = await client.listSpaceTree('space-1');

      expect(res.complete).toBe(true);
      expect(mocks.pageRepo.getSpaceDescendants).toHaveBeenCalledWith(
        'space-1',
        { includeContent: false },
      );
      expect(res.pages).toEqual([
        {
          id: 'p1',
          slugId: 's1',
          title: 'Root',
          parentPageId: null,
          hasChildren: true, // p2's parent is p1
          position: 'a0',
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'Child',
          parentPageId: 'p1',
          hasChildren: false,
          position: 'a1',
        },
      ]);
    });

    it('throws when the space is not found', async () => {
      const { service, mocks } = build();
      mocks.spaceRepo.findById.mockResolvedValue(undefined);
      await expect(service.bind(CTX).listSpaceTree('nope')).rejects.toThrow();
    });
  });

  describe('getPageJson', () => {
    it('returns the engine page shape with ISO updatedAt + content', async () => {
      const { service, mocks } = build();
      const updatedAt = new Date('2026-06-20T10:00:00.000Z');
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        slugId: 's1',
        title: 'Doc',
        parentPageId: null,
        spaceId: 'space-1',
        updatedAt,
        content: { type: 'doc', content: [] },
      });

      const res = await service.bind(CTX).getPageJson('p1');
      expect(mocks.pageRepo.findById).toHaveBeenCalledWith('p1', {
        includeContent: true,
      });
      expect(res).toEqual({
        id: 'p1',
        slugId: 's1',
        title: 'Doc',
        parentPageId: null,
        spaceId: 'space-1',
        updatedAt: '2026-06-20T10:00:00.000Z',
        content: { type: 'doc', content: [] },
      });
    });
  });

  describe('importPageMarkdown', () => {
    it('parses md, converts to ProseMirror, and writes body via collab', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        updatedAt: new Date('2026-06-20T11:00:00.000Z'),
      });

      const res = await service
        .bind(CTX)
        .importPageMarkdown('p1', '# Hello\n\nworld');

      // writeBody opened a collab connection tagged git-sync + service user.
      expect(mocks.collabGateway.openDirectConnection).toHaveBeenCalledTimes(1);
      const [docName, ctx] = mocks.collabGateway.openDirectConnection.mock
        .calls[0];
      expect(docName).toBe('page.p1');
      expect(ctx.actor).toBe('git-sync');
      expect(ctx.user).toEqual({ id: 'svc-user' });

      // transact ran and connection was disconnected (finally).
      expect(mocks.conn.transact).toHaveBeenCalledTimes(1);
      expect(mocks.conn.disconnect).toHaveBeenCalledTimes(1);
      expect(typeof mocks.conn.capturedFn).toBe('function');

      expect(res.updatedAt).toBe('2026-06-20T11:00:00.000Z');
    });

    it('crash-safe: the incoming doc is built before the connection opens, and the captured merge applies content', async () => {
      // The incoming Yjs doc is built BEFORE the connection opens, so a transform
      // failure can never mutate the live body. Here we run the captured transact
      // callback (the block-level merge) against a REAL empty Y.Doc and confirm it
      // ends up with content — the write produces a non-empty body, never wipes it.
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        updatedAt: new Date('2026-06-20T11:00:00.000Z'),
      });
      await service.bind(CTX).importPageMarkdown('p1', '# Hi\n\nthere');

      const realDoc = new Y.Doc();
      expect(() => mocks.conn.capturedFn?.(realDoc)).not.toThrow();
      // The body fragment is non-empty: the incoming block was merged in.
      expect(realDoc.getXmlFragment('default').length).toBeGreaterThan(0);
    });

    // The 2-way path (no base) is covered above; this exercises the THREE-WAY
    // branch that only fires when a `baseMarkdown` is supplied (review #5).
    describe('with a baseMarkdown (three-way merge)', () => {
      afterEach(() => jest.restoreAllMocks());

      it('builds a base doc and dispatches to mergeXmlFragments3Way (not the 2-way merge)', async () => {
        const { service, mocks } = build();
        mocks.pageRepo.findById.mockResolvedValue({
          id: 'p1',
          updatedAt: new Date('2026-06-20T11:00:00.000Z'),
        });
        // Spy through to the real implementations so we observe the dispatch.
        const merge3 = jest.spyOn(bodyMerge, 'mergeXmlFragments3Way');
        const merge2 = jest.spyOn(bodyMerge, 'mergeXmlFragments');

        await service
          .bind(CTX)
          .importPageMarkdown('p1', '# Full\n\ngit', '# Base\n\nbase');

        // The body write was staged through collab as before.
        expect(mocks.conn.transact).toHaveBeenCalledTimes(1);
        expect(typeof mocks.conn.capturedFn).toBe('function');

        // Running the captured merge against a real live doc takes the 3-way path:
        // the base was parsed/built and the 3-way helper is invoked with three
        // fragments; the 2-way fallback is NOT used.
        const liveDoc = new Y.Doc();
        expect(() => mocks.conn.capturedFn?.(liveDoc)).not.toThrow();

        expect(merge3).toHaveBeenCalledTimes(1);
        expect(merge2).not.toHaveBeenCalled();
        const [liveFrag, gitFrag, baseFrag] = merge3.mock.calls[0];
        expect(liveFrag).toBeInstanceOf(Y.XmlFragment);
        expect(gitFrag).toBeInstanceOf(Y.XmlFragment);
        // The third arg is the BASE fragment — proof the base markdown was parsed
        // and converted into its own doc for the common-ancestor comparison.
        expect(baseFrag).toBeInstanceOf(Y.XmlFragment);
      });
    });
  });

  describe('createPage', () => {
    it('creates the shell with git-sync provenance, writes body, returns id', async () => {
      const { service, mocks } = build();
      mocks.pageService.create.mockResolvedValue({ id: 'new-id' });
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'new-id',
        updatedAt: new Date('2026-06-20T12:00:00.000Z'),
      });

      const res = await service
        .bind(CTX)
        .createPage('Title', 'body md', 'space-1', 'parent-1');

      expect(mocks.pageService.create).toHaveBeenCalledWith(
        'svc-user',
        'ws-1',
        { spaceId: 'space-1', title: 'Title', parentPageId: 'parent-1' },
        { actor: 'git-sync', aiChatId: null },
      );
      expect(mocks.collabGateway.openDirectConnection).toHaveBeenCalledWith(
        'page.new-id',
        expect.objectContaining({ actor: 'git-sync' }),
      );
      expect(res).toEqual({
        data: { id: 'new-id' },
        updatedAt: '2026-06-20T12:00:00.000Z',
      });
    });
  });

  describe('deletePage', () => {
    it('uses the soft-delete path (removePage), not a force delete', async () => {
      const { service, mocks } = build();
      await service.bind(CTX).deletePage('p1');
      // Passes git-sync provenance so the soft-delete stamps
      // lastUpdatedSource='git-sync' (loop-guard, PR #119 review).
      expect(mocks.pageService.removePage).toHaveBeenCalledWith(
        'p1',
        'svc-user',
        'ws-1',
        { actor: 'git-sync', aiChatId: null },
      );
      // No forceDelete on the service surface used here.
      expect((mocks.pageService as any).forceDelete).toBeUndefined();
    });
  });

  describe('movePage', () => {
    it('computes a fractional position when none is supplied', async () => {
      // db query returns a last sibling at 'a0' -> jittered key after it.
      const { service, mocks } = build([{ position: 'a0' }]);
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        spaceId: 'space-1',
      });

      await service.bind(CTX).movePage('p1', 'parent-1');

      expect(mocks.pageService.movePage).toHaveBeenCalledTimes(1);
      const [dto, page, provenance] = mocks.pageService.movePage.mock.calls[0];
      expect(dto.pageId).toBe('p1');
      expect(dto.parentPageId).toBe('parent-1');
      expect(typeof dto.position).toBe('string');
      expect(dto.position.length).toBeGreaterThan(0);
      expect(page).toEqual({ id: 'p1', spaceId: 'space-1' });
      expect(provenance).toEqual({ actor: 'git-sync', aiChatId: null });
    });

    it('passes through an explicit position unchanged', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({
        id: 'p1',
        spaceId: 'space-1',
      });

      await service.bind(CTX).movePage('p1', null, 'zz');
      const [dto] = mocks.pageService.movePage.mock.calls[0];
      expect(dto.position).toBe('zz');
      // db not consulted for a supplied position.
      expect(mocks.db.selectFrom).not.toHaveBeenCalled();
    });
  });

  describe('renamePage', () => {
    it('updates only the title with git-sync provenance', async () => {
      const { service, mocks } = build();
      mocks.pageRepo.findById.mockResolvedValue({ id: 'p1', title: 'old' });

      await service.bind(CTX).renamePage('p1', 'new title');

      const [page, dto, user, provenance] =
        mocks.pageService.update.mock.calls[0];
      expect(page).toEqual({ id: 'p1', title: 'old' });
      expect(dto.title).toBe('new title');
      expect(user).toEqual({ id: 'svc-user' });
      expect(provenance).toEqual({ actor: 'git-sync', aiChatId: null });
    });
  });

  describe('restorePage', () => {
    it('restores via the repo restore path scoped to the workspace', async () => {
      const { service, mocks } = build();
      const res = await service.bind(CTX).restorePage('p1');
      // Stamps lastUpdatedSource='git-sync' on restore (loop-guard, PR #119).
      expect(mocks.pageRepo.restorePage).toHaveBeenCalledWith(
        'p1',
        'ws-1',
        'git-sync',
      );
      expect(res).toEqual({ id: 'p1' });
    });
  });

  // Phase-B+ continuous-sync methods: not yet called by the engine but wired into
  // the GitSyncClient seam (PR #119 review #5). Exercised via the bound client.
  describe('listRecentSince', () => {
    it('queries non-deleted pages newest-first and ISO-stringifies updatedAt', async () => {
      const rows = [
        {
          id: 'p1',
          slugId: 's1',
          title: 'A',
          parentPageId: null,
          spaceId: 'space-1',
          updatedAt: new Date('2026-06-20T10:00:00.000Z'),
        },
      ];
      const { service, mocks } = build(rows);
      const qb = mocks.db.selectFrom.mock.results; // populated after the call

      const out = (await service
        .bind(CTX)
        .listRecentSince('space-1', '2026-06-19T00:00:00.000Z', 100)) as any[];

      // Query builder shaped against the `pages` table with the expected chain.
      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const builder = qb[0].value;
      expect(builder.select).toHaveBeenCalled();
      expect(builder.orderBy).toHaveBeenCalledWith('updatedAt', 'desc');
      // deletedAt is null + the conditional spaceId / since / cap clauses.
      const whereArgs = builder.where.mock.calls.map((c: any[]) => c[0]);
      expect(whereArgs).toContain('deletedAt');
      expect(whereArgs).toContain('spaceId');
      expect(whereArgs).toContain('updatedAt');
      expect(builder.limit).toHaveBeenCalledWith(100);

      expect(out).toEqual([
        {
          id: 'p1',
          slugId: 's1',
          title: 'A',
          parentPageId: null,
          spaceId: 'space-1',
          updatedAt: '2026-06-20T10:00:00.000Z',
        },
      ]);
    });

    it('omits the spaceId / since / cap clauses when not supplied', async () => {
      const { service, mocks } = build([]);

      await service.bind(CTX).listRecentSince(undefined, null);

      const builder = mocks.db.selectFrom.mock.results[0].value;
      const whereArgs = builder.where.mock.calls.map((c: any[]) => c[0]);
      // Only the deletedAt-is-null guard; no spaceId / updatedAt> clauses.
      expect(whereArgs).toEqual(['deletedAt']);
      expect(builder.limit).not.toHaveBeenCalled();
    });
  });

  describe('listTrash', () => {
    it('queries soft-deleted pages and ISO-stringifies deletedAt (null stays null)', async () => {
      const rows = [
        {
          id: 'p1',
          slugId: 's1',
          title: 'Trashed',
          parentPageId: null,
          spaceId: 'space-1',
          deletedAt: new Date('2026-06-21T09:00:00.000Z'),
        },
        {
          id: 'p2',
          slugId: 's2',
          title: 'NoDate',
          parentPageId: null,
          spaceId: 'space-1',
          deletedAt: null,
        },
      ];
      const { service, mocks } = build(rows);

      const out = (await service.bind(CTX).listTrash('space-1')) as any[];

      expect(mocks.db.selectFrom).toHaveBeenCalledWith('pages');
      const builder = mocks.db.selectFrom.mock.results[0].value;
      const whereCalls = builder.where.mock.calls;
      // deletedAt is-not null (the trash predicate) + spaceId filter.
      expect(whereCalls).toContainEqual(['deletedAt', 'is not', null]);
      expect(whereCalls).toContainEqual(['spaceId', '=', 'space-1']);
      expect(builder.orderBy).toHaveBeenCalledWith('deletedAt', 'desc');

      expect(out[0].deletedAt).toBe('2026-06-21T09:00:00.000Z');
      expect(out[1].deletedAt).toBeNull();
    });
  });
});
