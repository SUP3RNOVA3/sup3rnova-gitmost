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
import {
  mergeXmlFragments,
  mergeXmlFragments3WayWithStats,
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

        // CONCURRENT-EDIT FLUSH (QA #119, finding #2). The 3-way merge below runs
        // against the LIVE Y.Doc, so a concurrent UI edit is only preserved if it
        // is already part of that doc. A user's edit is debounced before it lands
        // (the editor batches; the collab store is debounced up to 10s), so the
        // merge could otherwise run against a PRE-EDIT doc: git would then
        // clean-apply (no same-block conflict detected) and the in-flight UI edit
        // — even on a DIFFERENT block — would be silently dropped.
        //
        // Flushing the pending debounced store here (a) drains the event loop so a
        // just-arrived client Yjs update is applied to the live doc BEFORE we
        // merge, and (b) persists the live doc so the merge baseline is current
        // even on the doc-reload-from-DB path. After the flush the merge sees the
        // latest state, so an edit on a different block is MERGED (not overwritten)
        // and a genuine same-block edit is detected as a conflict -> the
        // boundary-snapshot in PersistenceExtension pins it to page history
        // (recoverable) instead of vanishing silently.
        await this.flushPendingStore(hocuspocus, documentName);

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
              const { conflicts } = mergeXmlFragments3WayWithStats(
                liveFrag,
                targetFrag,
                baseDoc.getXmlFragment('default'),
              );
              // SAME-BLOCK conflict contract (SPEC §9): a block both the human
              // and git changed resolves to GIT (deterministic). Make that
              // OBSERVABLE rather than silent — log it. The losing human content
              // is NOT destroyed: the persistence extension's boundary snapshot
              // pins the pre-merge page state to history on this user->git-sync
              // transition, so it stays recoverable.
              if (conflicts > 0) {
                this.logger.warn(
                  `git-sync merge for ${documentName}: ${conflicts} same-block ` +
                    `conflict(s) resolved to the git version; the prior page ` +
                    `state is preserved in page history (recoverable).`,
                );
              }
            } else {
              mergeXmlFragments(liveFrag, targetFrag);
            }
          },
        );
      },
    };
  }

  /**
   * Flush any pending DEBOUNCED store for `documentName` so the live Y.Doc and the
   * DB are current BEFORE a git-sync merge reads them (QA #119, finding #2 —
   * concurrent UI edit silently lost). Mirrors the PersistenceExtension.onDisconnect
   * flush: only acts when a store is actually pending (`isDebounced`), runs the
   * SAME scheduled payload (`executeNow`, preserving the edit's context/actor), and
   * never throws — a flush failure must not abort the git-sync write. Awaiting it
   * also drains the event loop, so a client Yjs update sitting in the socket buffer
   * is applied to the live doc before the merge transaction runs.
   */
  private async flushPendingStore(
    hocuspocus: Hocuspocus,
    documentName: string,
  ): Promise<void> {
    const debounceId = `onStoreDocument-${documentName}`;
    try {
      const debouncer = (hocuspocus as any)?.debouncer;
      if (!debouncer?.isDebounced?.(debounceId)) return;
      await debouncer.executeNow(debounceId);
    } catch (err) {
      this.logger.warn(
        `git-sync pre-merge flush failed for ${documentName}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
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
