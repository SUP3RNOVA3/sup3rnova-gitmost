import * as Y from 'yjs';
import { CollaborationHandler, writeTitleFragment } from './collaboration.handler';
import * as yjsUtil from './yjs.util';
import { User } from '@docmost/db/types/entity.types';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { CollaborationGateway } from './collaboration.gateway';
import {
  buildTitleSeedYdoc,
  jsonToText,
  tiptapExtensions,
} from './collaboration.util';

/**
 * Unit tests for the `applyCommentSuggestion` collab handler (phase 3 of #315).
 *
 * The handler runs `replaceYjsMarkedText` inside the owning instance's Y
 * transaction and returns the verdict to the caller. We exercise it against a
 * REAL in-memory Y.Doc carrying a marked comment run, driven through a FAKE
 * hocuspocus whose openDirectConnection().transact(fn) simply runs fn(doc) —
 * mirroring how the real hocuspocus DirectConnection invokes the callback with
 * the shared document (it does not forward the callback's return value, which is
 * exactly why withYdocConnection captures it via a closure).
 */

// Build a Y.Doc with a single paragraph whose text carries a `comment` mark for
// the given commentId — the shape `replaceYjsMarkedText` walks in production.
function buildDocWithComment(text: string, commentId: string) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  const xmlText = new Y.XmlText();
  xmlText.insert(0, text);
  xmlText.format(0, text.length, { comment: { commentId, resolved: false } });
  paragraph.insert(0, [xmlText]);
  fragment.insert(0, [paragraph]);
  return doc;
}

// Fake hocuspocus exposing only what withYdocConnection needs: a direct
// connection whose transact() runs the callback against `doc`.
function fakeHocuspocus(doc: Y.Doc) {
  const connection = {
    transact: jest.fn(async (fn: (d: Y.Doc) => void) => {
      fn(doc);
    }),
    disconnect: jest.fn(async () => {}),
  };
  const hocuspocus = {
    openDirectConnection: jest.fn(async () => connection),
  } as any;
  return { hocuspocus, connection };
}

const user = { id: 'u1' } as unknown as User;

describe('CollaborationHandler.applyCommentSuggestion', () => {
  it('applies the replacement and returns the verdict when the marked text matches', async () => {
    const doc = buildDocWithComment('Hello world', 'c1');
    const { hocuspocus, connection } = fakeHocuspocus(doc);
    const handler = new CollaborationHandler();
    const handlers = handler.getHandlers(hocuspocus);

    const result = await handlers.applyCommentSuggestion('doc-1', {
      commentId: 'c1',
      expectedText: 'Hello world',
      newText: 'Goodbye world',
      user,
    });

    expect(result).toEqual({ applied: true, currentText: 'Goodbye world' });
    // The mutation ran inside the transaction and hit the real doc.
    expect(connection.transact).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(doc.getXmlFragment('default').toString()).toContain(
      'Goodbye world',
    );
  });

  it('rejects (applied=false) and returns the current text when it changed', async () => {
    const doc = buildDocWithComment('Hello world', 'c1');
    const { hocuspocus } = fakeHocuspocus(doc);
    const handler = new CollaborationHandler();
    const handlers = handler.getHandlers(hocuspocus);

    const result = await handlers.applyCommentSuggestion('doc-1', {
      commentId: 'c1',
      expectedText: 'Stale expected text',
      newText: 'Goodbye world',
      user,
    });

    expect(result).toEqual({ applied: false, currentText: 'Hello world' });
    // Nothing was replaced.
    expect(doc.getXmlFragment('default').toString()).toContain(
      'Hello world',
    );
  });

  it('forwards the exact args to replaceYjsMarkedText and returns its result', async () => {
    const doc = buildDocWithComment('abc', 'c9');
    const { hocuspocus } = fakeHocuspocus(doc);
    const spy = jest
      .spyOn(yjsUtil, 'replaceYjsMarkedText')
      .mockReturnValue({ applied: true, currentText: 'xyz' });
    const handler = new CollaborationHandler();
    const handlers = handler.getHandlers(hocuspocus);

    const result = await handlers.applyCommentSuggestion('doc-1', {
      commentId: 'c9',
      expectedText: 'abc',
      newText: 'xyz',
      user,
    });

    expect(spy).toHaveBeenCalledWith(
      doc.getXmlFragment('default'),
      'c9',
      'abc',
      'xyz',
    );
    expect(result).toEqual({ applied: true, currentText: 'xyz' });
    spy.mockRestore();
  });

  it('withYdocConnection returns the callback result (transact does not forward it)', async () => {
    const doc = new Y.Doc();
    const { hocuspocus } = fakeHocuspocus(doc);
    const handler = new CollaborationHandler();

    const value = await handler.withYdocConnection(
      hocuspocus,
      'doc-1',
      {},
      () => 42,
    );

    expect(value).toBe(42);
  });
});

describe('CollaborationHandler.deleteCommentMark', () => {
  it('strips the comment mark for the given commentId (ephemeral suggestion #329)', async () => {
    const doc = buildDocWithComment('Hello world', 'c1');
    const { hocuspocus, connection } = fakeHocuspocus(doc);
    const handler = new CollaborationHandler();
    const handlers = handler.getHandlers(hocuspocus);

    await handlers.deleteCommentMark('doc-1', { commentId: 'c1', user });

    // The mark is gone; the text itself stays (deleting the anchor, not the run).
    const xmlText = (
      doc.getXmlFragment('default').get(0) as Y.XmlElement
    ).get(0) as Y.XmlText;
    expect(xmlText.toDelta()).toEqual([{ insert: 'Hello world' }]);
    expect(connection.transact).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it('routes the removal through removeYjsMarkByAttribute with the right args', async () => {
    const doc = buildDocWithComment('abc', 'c9');
    const { hocuspocus } = fakeHocuspocus(doc);
    const spy = jest.spyOn(yjsUtil, 'removeYjsMarkByAttribute');
    const handler = new CollaborationHandler();
    const handlers = handler.getHandlers(hocuspocus);

    await handlers.deleteCommentMark('doc-1', { commentId: 'c9', user });

    expect(spy).toHaveBeenCalledWith(
      doc.getXmlFragment('default'),
      'comment',
      'commentId',
      'c9',
    );
    spy.mockRestore();
  });

  it('leaves a different comment\'s mark intact', async () => {
    const doc = buildDocWithComment('keep me', 'other');
    const { hocuspocus } = fakeHocuspocus(doc);
    const handler = new CollaborationHandler();
    const handlers = handler.getHandlers(hocuspocus);

    await handlers.deleteCommentMark('doc-1', { commentId: 'c1', user });

    const xmlText = (
      doc.getXmlFragment('default').get(0) as Y.XmlElement
    ).get(0) as Y.XmlText;
    expect(xmlText.toDelta()).toEqual([
      {
        insert: 'keep me',
        attributes: { comment: { commentId: 'other', resolved: false } },
      },
    ]);
  });
});

// Read the plain text held in the doc's 'title' XmlFragment, the same way
// PersistenceExtension.onStoreDocument extracts it before writing page.title.
const readTitleText = (doc: Y.Doc): string => {
  const titleJson = TiptapTransformer.fromYdoc(doc, 'title');
  return titleJson ? jsonToText(titleJson).trim() : '';
};

describe('writeTitleFragment — the clear+seed title write (Bug 1)', () => {
  it('replaces an OLD title fragment with EXACTLY the new title (no duplication)', () => {
    // Seed the doc's 'title' fragment with an OLD title, like a real page.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(buildTitleSeedYdoc('Old Title')));
    expect(readTitleText(doc)).toBe('Old Title');

    writeTitleFragment(doc, 'New Title');

    // The fragment must contain EXACTLY the new title — not "Old TitleNew Title"
    // (append) or "New TitleNew Title" (duplication). A single heading node.
    expect(readTitleText(doc)).toBe('New Title');

    const titleJson = TiptapTransformer.fromYdoc(doc, 'title') as any;
    expect(titleJson.content).toHaveLength(1);
    expect(titleJson.content[0].type).toBe('heading');
  });

  it('seeds the title fragment when it started empty', () => {
    const doc = new Y.Doc();
    // Force the 'title' fragment to exist but be empty.
    doc.getXmlFragment('title');
    expect(readTitleText(doc)).toBe('');

    writeTitleFragment(doc, 'First Title');

    expect(readTitleText(doc)).toBe('First Title');
  });

  it('does not corrupt the body when rewriting the title', () => {
    // A doc with both a body and an old title; the body must survive untouched.
    const doc = new Y.Doc();
    const bodyDoc = TiptapTransformer.toYdoc(
      {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'body text' }] },
        ],
      },
      'default',
      tiptapExtensions,
    );
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(bodyDoc));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(buildTitleSeedYdoc('Old')));

    writeTitleFragment(doc, 'New');

    expect(readTitleText(doc)).toBe('New');
    const bodyJson = TiptapTransformer.fromYdoc(doc, 'default');
    expect(jsonToText(bodyJson)).toContain('body text');
  });
});

describe('CollaborationGateway.writePageTitle — Redis-independent path', () => {
  // Build a gateway with only its hocuspocus.openDirectConnection stubbed; the
  // method must drive the clear+seed through that direct connection (NOT through
  // redisSync), so the title write survives COLLAB_DISABLE_REDIS.
  const makeGateway = (doc: Y.Doc) => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const transact = jest.fn(async (fn: (d: Y.Doc) => void) => {
      fn(doc);
    });
    const openDirectConnection = jest
      .fn()
      .mockResolvedValue({ transact, disconnect });

    const gateway = Object.create(CollaborationGateway.prototype);
    // redisSync is intentionally null — this is the no-Redis scenario.
    gateway.redisSync = null;
    gateway.hocuspocus = { openDirectConnection } as any;

    return { gateway, openDirectConnection, transact, disconnect };
  };

  it('writes the new title via openDirectConnection and disconnects', async () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(buildTitleSeedYdoc('Old Title')));

    const { gateway, openDirectConnection, disconnect } = makeGateway(doc);

    await gateway.writePageTitle('page-1', 'New Title', { user: { id: 'u1' } });

    expect(openDirectConnection).toHaveBeenCalledWith(
      'page.page-1',
      expect.objectContaining({ user: { id: 'u1' } }),
    );
    expect(readTitleText(doc)).toBe('New Title');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('threads agent provenance into the connection context', async () => {
    const doc = new Y.Doc();
    const { gateway, openDirectConnection } = makeGateway(doc);

    await gateway.writePageTitle('page-1', 'Agent Title', {
      user: { id: 'u1' },
      actor: 'agent',
      aiChatId: 'chat-1',
    });

    expect(openDirectConnection).toHaveBeenCalledWith(
      'page.page-1',
      expect.objectContaining({ actor: 'agent', aiChatId: 'chat-1' }),
    );
  });

  it('disconnects even when the transaction throws', async () => {
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const openDirectConnection = jest.fn().mockResolvedValue({
      transact: jest.fn().mockRejectedValue(new Error('boom')),
      disconnect,
    });
    const gateway = Object.create(CollaborationGateway.prototype);
    gateway.redisSync = null;
    gateway.hocuspocus = { openDirectConnection } as any;

    await expect(
      gateway.writePageTitle('page-1', 'X', {}),
    ).rejects.toThrow('boom');
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
