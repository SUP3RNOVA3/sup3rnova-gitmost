import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { setYjsMark, updateYjsMarkAttribute, YjsSelection } from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';
import {
  mergeXmlFragments,
  mergeXmlFragments3Way,
} from './merge/yjs-body-merge';

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
       * Git-sync body write, applied as a block-level MERGE into the LIVE doc on
       * the instance that OWNS it (routed here via the custom-event channel —
       * see CollaborationGateway.writePageBody). Running on the owning instance
       * is what makes a connected editor CONVERGE: the merge mutates the shared
       * Document, whose update is broadcast to every connection, so the editor's
       * CRDT applies the git change instead of silently reverting it on its next
       * autosave (the data-loss bug this fixes).
       *
       * With a `baseProsemirrorJson` (the last-synced common ancestor) it does a
       * THREE-WAY merge — a block only the human changed is kept, a block only
       * git changed is taken (conflicts -> git). Without a base it falls back to
       * the 2-way merge.
       */
      gitSyncWriteBody: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          baseProsemirrorJson?: any;
          userId: string;
        },
      ) => {
        const { prosemirrorJson, baseProsemirrorJson, userId } = payload;

        // Build the incoming (and base) Yjs docs BEFORE opening the connection /
        // touching the live doc. If a transform throws (a malformed/unsupported
        // doc) we must NOT have mutated the live body — otherwise a conversion
        // failure could leave the page empty (crash-safe conversion).
        const targetDoc = TiptapTransformer.toYdoc(
          prosemirrorJson,
          'default',
          tiptapExtensions,
        );
        const baseDoc =
          baseProsemirrorJson != null
            ? TiptapTransformer.toYdoc(
                baseProsemirrorJson,
                'default',
                tiptapExtensions,
              )
            : null;

        // actor:'git-sync' + the service user flow into PersistenceExtension
        // (lastUpdatedSource='git-sync', lastUpdatedById=userId).
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { actor: 'git-sync', user: { id: userId } },
          (doc) => {
            const liveFrag = doc.getXmlFragment('default');
            const targetFrag = targetDoc.getXmlFragment('default');
            if (baseDoc) {
              mergeXmlFragments3Way(
                liveFrag,
                targetFrag,
                baseDoc.getXmlFragment('default'),
              );
            } else {
              mergeXmlFragments(liveFrag, targetFrag);
            }
          },
        );
      },
    };
  }

  async withYdocConnection(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    fn: (doc: Document) => void,
  ): Promise<void> {
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      await connection.transact(fn);
    } finally {
      await connection.disconnect();
    }
  }
}
