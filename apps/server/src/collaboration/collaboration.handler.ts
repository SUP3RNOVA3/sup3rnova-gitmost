import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  buildTitleSeedYdoc,
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import {
  removeYjsMarkByAttribute,
  replaceYjsMarkedText,
  setYjsMark,
  updateYjsMarkAttribute,
  YjsSelection,
} from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

/**
 * Clear+reseed the 'title' XmlFragment of `doc` so it holds EXACTLY `title`.
 *
 * Used by the gateway's direct `writePageTitle` method to write a new page
 * title INTO the page's Yjs 'title' fragment. The title lives in the same
 * Y.Doc as the body; onStoreDocument extracts it on every save, so a REST/MCP
 * rename that only updated the page.title DB column would be reverted on the
 * next collaborative save unless the Yjs 'title' fragment is kept in sync.
 * The whole fragment is replaced (no merge/append),
 * mirroring the 'replace' body path: the new title fully supersedes the old.
 *
 * DELIBERATE TRADE-OFF: because this does a FULL clear+replace of the 'title'
 * fragment, a REST/MCP rename arriving while a user is actively editing the
 * title in an open editor WILL overwrite that in-progress edit. This is
 * acceptable — the title is a short, rarely-concurrently-edited field — and is
 * preferable to leaving a stale Yjs title that onStoreDocument would revert the
 * DB column to on the next save.
 */
export function writeTitleFragment(doc: Y.Doc, title: string): void {
  const titleFragment = doc.getXmlFragment('title');

  if (titleFragment.length > 0) {
    titleFragment.delete(0, titleFragment.length);
  }

  const newTitleDoc = buildTitleSeedYdoc(title);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(newTitleDoc));
}

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);

  getHandlers(hocuspocus: Hocuspocus) {
    return {
      alterState: async (documentName: string, payload: { pageId: string }) => {
        // dummy
        // this.logger.log('Processing', documentName, payload);
        // await this.withYdocConnection(hocuspocus, documentName, {}, (doc) => {
        //   const fragment = doc.getXmlFragment('default');
        //});
      },
      setCommentMark: async (
        documentName: string,
        payload: {
          yjsSelection: YjsSelection;
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { yjsSelection, commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            setYjsMark(doc, fragment, yjsSelection, 'comment', {
              commentId,
              resolved,
            });
          },
        );
      },
      resolveCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            updateYjsMarkAttribute(
              fragment,
              'comment',
              { name: 'commentId', value: commentId },
              { resolved },
            );
          },
        );
      },
      deleteCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          user: User;
        },
      ) => {
        const { commentId, user } = payload;
        // Ephemeral suggestions (#329): when a suggestion-edit is dismissed or an
        // applied one has no replies, the comment is hard-deleted and its inline
        // anchor must vanish too. Mirror resolveCommentMark exactly, but instead
        // of flipping the mark's `resolved` attribute we STRIP the `comment` mark
        // entirely via removeYjsMarkByAttribute so no orphan highlight remains in
        // the collaborative document.
        //
        // Routing this through collaboration.gateway's handleYjsEvent means the
        // COLLAB_DISABLE_REDIS path invokes this handler directly (never a silent
        // no-op) and a missing live instance is a hard error — the same guarantee
        // applyCommentSuggestion/resolveCommentMark rely on.
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            removeYjsMarkByAttribute(
              fragment,
              'comment',
              'commentId',
              commentId,
            );
          },
        );
      },
      applyCommentSuggestion: async (
        documentName: string,
        payload: {
          commentId: string;
          expectedText: string;
          newText: string;
          user: User;
        },
      ): Promise<{ applied: boolean; currentText: string | null }> => {
        const { commentId, expectedText, newText, user } = payload;
        // Run the check-and-replace inside the owning instance's Y transaction so
        // the delete+insert are atomic. The verdict from replaceYjsMarkedText is
        // returned to the API-server caller (cross-process via the Redis bridge,
        // or locally when Redis is disabled — see collaboration.gateway.ts).
        return this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            return replaceYjsMarkedText(
              fragment,
              commentId,
              expectedText,
              newText,
            );
          },
        );
      },
      updatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
        },
      ) => {
        const { operation, user } = payload;
        const { prosemirrorJson } = payload;
        this.logger.debug('Updating page content via yjs', documentName);

        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');

            if (operation === 'replace') {
              if (fragment.length > 0) {
                fragment.delete(0, fragment.length);
              }

              const newDoc = TiptapTransformer.toYdoc(
                prosemirrorJson,
                'default',
                tiptapExtensions,
              );
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
            } else {
              const newContent = prosemirrorJson.content || [];
              const yElements = newContent.map(prosemirrorNodeToYElement);
              const position = operation === 'prepend' ? 0 : fragment.length;
              fragment.insert(position, yElements);
            }
          },
        );
      },
    };
  }

  async withYdocConnection<T>(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    // `fn` MUST be synchronous: hocuspocus `connection.transact(fn)` runs fn
    // synchronously and does NOT await it, so any mutations after an `await`
    // inside fn would execute OUTSIDE the Yjs transaction and lose atomicity.
    fn: (doc: Document) => T,
  ): Promise<T> {
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      // hocuspocus `connection.transact(fn)` invokes fn(document) but does NOT
      // forward fn's return value, so we capture it in a closure and return it
      // after the transaction (and its storeDocument hooks) resolve.
      let result: T;
      await connection.transact((doc) => {
        result = fn(doc);
      });
      return result!;
    } finally {
      await connection.disconnect();
    }
  }
}
