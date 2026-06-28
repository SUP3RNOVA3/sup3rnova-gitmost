import * as Y from 'yjs';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { CollaborationGateway } from './collaboration.gateway';
import { PersistenceExtension } from './extensions/persistence.extension';
import {
  buildTitleSeedYdoc,
  jsonToText,
  tiptapExtensions,
} from './collaboration.util';

/**
 * F1 (variant C) — rename durability for a page with an already-persisted Yjs
 * 'title' fragment and NO live editor (the REST/MCP/agent rename path).
 *
 * The bug: PageService.update writes the NEW title to the `page.title` COLUMN,
 * then calls gateway.writePageTitle, which loads the page's ydoc (fragment =
 * OLD) and overwrites it to NEW in memory. On disconnect, onStoreDocument sees
 * titleText(NEW) === column(NEW) → no-op fast-path → it does NOT persist the
 * in-memory fragment. So `page.ydoc` keeps the OLD title, and a LATER body edit
 * loads the OLD fragment, sees it differs from the column, and silently reverts
 * the column back to OLD.
 *
 * The fix: writePageTitle persists the 'title' fragment to `page.ydoc` DIRECTLY
 * (via PersistenceExtension.persistTitleFragmentYdoc) after the transact, so the
 * persisted fragment and the column stay consistent.
 *
 * This test drives the REAL writePageTitle + the REAL onStoreDocument against an
 * in-memory page row, so it FAILS on the pre-fix no-op behaviour and PASSES after.
 */

const PAGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const USER_ID = 'user-1';
const OLD_TITLE = 'Old Title';
const NEW_TITLE = 'Renamed Title';

const bodyJson = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

// Build the initial persisted ydoc carrying BOTH a 'title' fragment and a body.
const makeInitialYdoc = (title: string, body: any): Buffer => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(buildTitleSeedYdoc(title)));
  Y.applyUpdate(
    doc,
    Y.encodeStateAsUpdate(TiptapTransformer.toYdoc(body, 'default', tiptapExtensions)),
  );
  return Buffer.from(Y.encodeStateAsUpdate(doc));
};

// Load a doc from a persisted buffer (mirrors openDirectConnection loading from
// persistence when no editor is connected). hocuspocus augments the live doc
// with broadcastStateless(); a bare Y.Doc lacks it, so stub it.
const loadDoc = (buf: Buffer): Y.Doc => {
  const doc = new Y.Doc();
  if (buf) Y.applyUpdate(doc, new Uint8Array(buf));
  (doc as any).broadcastStateless = jest.fn();
  return doc;
};

// Read the 'title' fragment text from a persisted buffer.
const readTitle = (buf: Buffer): string => {
  const doc = loadDoc(buf);
  const titleJson = TiptapTransformer.fromYdoc(doc, 'title');
  return titleJson ? jsonToText(titleJson).trim() : '';
};

describe('rename durability (F1 variant C): persisted title fragment survives a body edit', () => {
  it('persists the renamed title into page.ydoc so a later body edit does not revert it', async () => {
    // In-memory page row = the DB.
    const row: any = {
      id: PAGE_ID,
      slugId: 'slug-1',
      spaceId: 'space-1',
      workspaceId: 'ws-1',
      creatorId: 'creator-1',
      contributorIds: ['creator-1'],
      createdAt: new Date('2020-01-01T00:00:00Z'),
      lastUpdatedSource: 'user',
      title: OLD_TITLE,
      // content column mirrors the normalized body in the ydoc.
      content: TiptapTransformer.fromYdoc(
        loadDoc(makeInitialYdoc(OLD_TITLE, bodyJson('BODY V1'))),
        'default',
      ),
      ydoc: makeInitialYdoc(OLD_TITLE, bodyJson('BODY V1')),
    };

    const pageRepo = {
      findById: jest.fn(async () => ({ ...row })),
      updatePage: jest.fn(async (data: any, _pageId?: string) => {
        Object.assign(row, data, { updatedAt: new Date() });
      }),
    };
    const pageHistoryRepo = {
      saveHistory: jest.fn().mockResolvedValue(undefined),
      findPageLastHistory: jest.fn().mockResolvedValue(null),
    };
    const noopQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const collabHistory = { addContributors: jest.fn().mockResolvedValue(undefined) };
    const transclusionService = {
      syncPageTransclusions: jest.fn().mockResolvedValue(undefined),
      syncPageReferences: jest.fn().mockResolvedValue(undefined),
      syncPageTemplateReferences: jest.fn().mockResolvedValue(undefined),
    };
    // db whose transaction().execute(fn) runs fn with a trx stub (drives the
    // real executeTx helper without a database).
    const db = {
      transaction: () => ({
        execute: (fn: (trx: any) => Promise<any>) => fn({ __trx: true }),
      }),
    };

    const ext = new PersistenceExtension(
      pageRepo as any,
      pageHistoryRepo as any,
      db as any,
      noopQueue as any,
      noopQueue as any,
      noopQueue as any,
      collabHistory as any,
      transclusionService as any,
    );
    jest.spyOn(ext['logger'], 'debug').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(ext['logger'], 'error').mockImplementation(() => undefined);

    const documentName = `page.${PAGE_ID}`;
    // Fake hocuspocus: openDirectConnection loads a doc from the CURRENT persisted
    // ydoc (no live editor) and, on disconnect, runs the real onStoreDocument —
    // exactly the no-live-editor unload path.
    const fakeHocuspocus = {
      openDirectConnection: jest.fn(async (name: string, context: any) => {
        const liveDoc = loadDoc(row.ydoc);
        return {
          transact: async (fn: (doc: Y.Doc) => void) => fn(liveDoc),
          disconnect: async () => {
            await ext.onStoreDocument({
              documentName: name,
              document: liveDoc,
              context,
            } as any);
          },
        };
      }),
    };

    const gateway: CollaborationGateway = Object.create(
      CollaborationGateway.prototype,
    );
    (gateway as any).hocuspocus = fakeHocuspocus;
    (gateway as any).persistenceExtension = ext;

    // --- REST/service rename (no live editor) ---
    // 1) PageService.update writes the NEW title to the column.
    await pageRepo.updatePage({ title: NEW_TITLE }, PAGE_ID);
    // 2) PageService.update syncs the Yjs 'title' fragment.
    await gateway.writePageTitle(PAGE_ID, NEW_TITLE, {
      user: { id: USER_ID } as any,
    });

    // Reload the persisted ydoc: the 'title' fragment must now be NEW.
    // (Pre-fix this is still OLD — writePageTitle did not persist the fragment.)
    expect(readTitle(row.ydoc)).toBe(NEW_TITLE);

    // --- a later body edit must NOT revert the title ---
    const editDoc = loadDoc(row.ydoc);
    const frag = editDoc.getXmlFragment('default');
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'appended');
    p.insert(0, [t]);
    frag.insert(frag.length, [p]);

    await ext.onStoreDocument({
      documentName,
      document: editDoc,
      context: { user: { id: USER_ID } },
    } as any);

    // The body edit was persisted, and the title stayed NEW in BOTH the column
    // and the persisted ydoc fragment (pre-fix the column reverts to OLD).
    expect(row.title).toBe(NEW_TITLE);
    expect(readTitle(row.ydoc)).toBe(NEW_TITLE);
  });
});
