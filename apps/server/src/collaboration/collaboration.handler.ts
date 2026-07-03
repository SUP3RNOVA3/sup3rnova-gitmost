import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import {
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
