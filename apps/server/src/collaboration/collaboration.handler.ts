import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { pageContentHash } from './content-hash.util';
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
 * #647 refinement B — result of the `readLiveContent` probe (the owner-side half
 * of the `readLiveIfLoaded` primitive #654 depends on).
 *  - `loaded:true`  → the document IS in this instance's memory and `content`/
 *    `hash` are the FULLY HYDRATED live doc (property 5). `hash` is coherent with
 *    `content` (both derived from the same `fromYdoc`).
 *  - `loaded:false` → the document is not loaded on this instance. The probe NEVER
 *    force-loads it (property 2) and NEVER claims ownership (property 3).
 * The `unreachable` case (owner exists but the probe timed out / errored) is
 * produced by the BRIDGE layer, not this handler.
 */
export type ReadLiveContentResult =
  | { loaded: true; content: any; hash: string }
  | { loaded: false };

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
      /**
       * #647 refinement B — NON-CLAIMING, NON-FORCE-LOADING read of the live doc.
       *
       * The owner-side half of `readLiveIfLoaded` (#654's gating primitive). It
       * reads ONLY what is already hydrated in this instance's memory:
       *  - property 2 (no force-load): we consult `hocuspocus.documents` directly
       *    and NEVER call `openDirectConnection` (which would load from the DB);
       *  - property 3 (non-claiming): no lock is taken here — the bridge decides
       *    routing with a plain GET, and this local read touches no lock key;
       *  - property 5 (loaded ⇒ hydrated): a doc present in `documents` has already
       *    run `onLoadDocument` (synchronous `Y.applyUpdate`), so `fromYdoc` yields
       *    the fully hydrated live content, hashed coherently in the SAME pass.
       */
      readLiveContent: async (
        documentName: string,
      ): Promise<ReadLiveContentResult> => {
        const doc = hocuspocus.documents.get(documentName);
        if (!doc) {
          return { loaded: false };
        }
        const content = TiptapTransformer.fromYdoc(doc, 'default');
        return { loaded: true, content, hash: pageContentHash(content) };
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
