import { HocuspocusProvider } from "@hocuspocus/provider";
import { TiptapTransformer } from "@hocuspocus/transformer";
import * as Y from "yjs";
import WebSocket from "ws";
import { Node as PMNode } from "@tiptap/pm/model";
import { updateYFragment } from "y-prosemirror";
import { JSDOM } from "jsdom";
// #293 STEP 5: the pure markdown -> ProseMirror import path is now owned by the
// shared package (canonical `^[…]` footnotes, `$…$` math, `==` highlight, the
// media-family md forms, comment-directive attrs, callouts and task lists all
// handled there). MCP consumes it directly instead of maintaining its own
// drifted marked pipeline; only the collab/yjs write glue and the footnote
// canonicalization wrapper stay mcp-side.
import { markdownToProseMirror } from "@docmost/prosemirror-markdown";
import { docmostExtensions, docmostSchema } from "./docmost-schema.js";
import { withPageLock } from "./page-lock.js";
import { sanitizeForYjs, findUnstorableAttr } from "./node-ops.js";
import { canonicalizeFootnotes } from "./footnote-canonicalize.js";
import { summarizeChange, VerifyReport } from "./diff.js";

export { markdownToProseMirror };

/**
 * Build the descriptive error for an opaque Yjs encode failure ("Unexpected
 * content type"), shared by both encode paths (`buildYDoc` -> `toYdoc` and
 * `applyDocToFragment` -> `updateYFragment`) so the message wording stays in one
 * place. `label` names the stage that failed (diagnostic). `sanitizeForYjs`
 * already stripped `undefined` attrs, so a remaining failure is pinpointed via
 * `findUnstorableAttr`.
 */
function unstorableYjsError(safe: any, label: string, e: unknown): Error {
  const bad = findUnstorableAttr(safe);
  return new Error(
    `Failed to encode document to Yjs (${label}): ${e instanceof Error ? e.message : String(e)}.${bad ? ` Offending attribute: ${bad}.` : " A node/mark attribute likely holds a value Yjs cannot store (e.g. undefined)."}`,
  );
}

/**
 * The resolved value of every content-mutating collab write: the document that
 * was written (or the live doc when the transform aborted) plus a verifiable
 * change report describing what actually changed in the document.
 */
export interface MutationResult {
  doc: any;
  verify: VerifyReport;
}

// Setup DOM environment for Tiptap HTML parsing in Node.js
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
global.window = dom.window as any;
global.document = dom.window.document;
// @ts-ignore
global.Element = dom.window.Element;
// @ts-ignore
global.WebSocket = WebSocket;
// Navigator is read-only in newer Node versions and already exists
// global.navigator = dom.window.navigator;

/**
 * Page-write variant of the package's `markdownToProseMirror`: imports markdown
 * then re-runs mcp's footnote canonicalizer over the result.
 *
 * Footnote layering after #293 STEP 5:
 *   - The package's `markdownToProseMirror` already ASSEMBLES footnotes on import
 *     (canon #2): inline `^[body]` markers become the schema's
 *     `footnoteReference` + a single doc-level `footnotesList`, with ids assigned
 *     sequentially (`fn-1`, `fn-2`, …) in first-reference order and identical
 *     bodies merged. So the import output is ALREADY in canonical footnote
 *     topology.
 *   - `canonicalizeFootnotes` runs AFTER as the mcp write-path invariant shared
 *     with every other full-document persist path (`update_page_json`,
 *     `docmost_transform`, `insert_footnote`, …). Because the package output is
 *     already canonical, this layer is a no-op here (idempotent) — it exists so
 *     the page-write contract is enforced uniformly regardless of how the PM doc
 *     was produced, not because the import needs fixing.
 *
 * Use this ONLY for full-document PAGE writes. Comment bodies call the package's
 * plain `markdownToProseMirror` (no canonicalization) — safe now because inline
 * `^[body]` footnotes carry their body at the reference point, so a comment can
 * no longer produce a reference-less footnote definition to be dropped.
 */
export async function markdownToProseMirrorCanonical(
  markdownContent: string,
): Promise<any> {
  return canonicalizeFootnotes(await markdownToProseMirror(markdownContent));
}

/**
 * Build the collaboration WebSocket URL from an API base URL:
 * switch http(s)->ws(s), strip a trailing /api, mount on /collab.
 * Shared by the live read and the mutate path so both target the same socket.
 */
export function buildCollabWsUrl(baseUrl: string): string {
  let wsUrl = baseUrl.replace(/^http/, "ws");
  try {
    const urlObj = new URL(wsUrl);
    if (urlObj.pathname.endsWith("/api") || urlObj.pathname.endsWith("/api/")) {
      urlObj.pathname = urlObj.pathname.replace(/\/api\/?$/, "");
    }
    urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/collab";
    // Drop any query/hash from the base URL so it is not carried into the
    // collaboration ws URL.
    urlObj.search = "";
    urlObj.hash = "";
    wsUrl = urlObj.toString();
  } catch (e) {
    // Fallback if URL parsing fails
    if (!wsUrl.endsWith("/collab")) {
      wsUrl = wsUrl.replace(/\/$/, "") + "/collab";
    }
  }
  return wsUrl;
}

/**
 * Encode a ProseMirror doc to a Yjs document, sanitizing it first and turning
 * the opaque yjs "Unexpected content type" failure into a descriptive error.
 *
 * `sanitizeForYjs` strips `undefined` node/mark attributes (the common cause of
 * the failure); if `toYdoc` still throws, `findUnstorableAttr` is used to point
 * at the offending attribute path.
 */
export function buildYDoc(doc: any): Y.Doc {
  const safe = sanitizeForYjs(doc);
  try {
    return TiptapTransformer.toYdoc(safe, "default", docmostExtensions);
  } catch (e) {
    throw unstorableYjsError(safe, "toYdoc", e);
  }
}

/**
 * Write a new ProseMirror doc into the live Yjs fragment by STRUCTURAL DIFF,
 * preserving the Yjs identity of unchanged nodes (issue #152).
 *
 * The previous approach deleted the whole fragment and re-applied a fresh Y.Doc,
 * which discarded every Yjs node id. y-prosemirror anchors the editor selection
 * to those ids, so an open editor's cursor lost its anchor and snapped to the
 * end of the document on every agent write (most visibly on comment anchoring,
 * which changes no text at all). `updateYFragment` is exactly the routine the
 * editor itself uses to sync ProseMirror edits into Yjs: it diffs the new node
 * against the current fragment and touches only the changed children, so
 * unchanged nodes keep their ids and the live cursor stays put.
 *
 * Must run inside a single `transact` so the diff applies atomically (no remote
 * update interleaves). Keeps `buildYDoc`'s `findUnstorableAttr` diagnostic for
 * the opaque "Unexpected content type" encode failure.
 */
export function applyDocToFragment(ydoc: Y.Doc, newDoc: any): void {
  const safe = sanitizeForYjs(newDoc);
  const fragment = ydoc.getXmlFragment("default");
  // Hydrate the ProseMirror node in its OWN try so a failure here (e.g. an
  // unknown node type) is labelled "fromJSON" — the stage that actually threw —
  // instead of being misattributed to the Yjs write stage (#154 review).
  let pmNode: PMNode;
  try {
    pmNode = PMNode.fromJSON(docmostSchema, safe);
  } catch (e) {
    throw unstorableYjsError(safe, "fromJSON", e);
  }
  try {
    ydoc.transact(() => {
      updateYFragment(ydoc, fragment, pmNode, {
        mapping: new Map(),
        isOMark: new Map(),
      });
    });
  } catch (e) {
    throw unstorableYjsError(safe, "updateYFragment", e);
  }
}

/**
 * Run an independent Yjs-encodability check (the same `sanitizeForYjs` + schema
 * the apply path uses) and throw the same descriptive error when the doc cannot
 * be stored. Used by the dry-run preview.
 *
 * Note: it does NOT run `updateYFragment` against the live fragment, so it is an
 * encodability GATE, not a byte-for-byte rehearsal of apply — `buildYDoc`
 * (`toYdoc`) and `applyDocToFragment` (`updateYFragment`) are two different
 * encoders that nonetheless reject the same unstorable attributes. To narrow the
 * preview/apply gap it ALSO rehearses the apply path's `PMNode.fromJSON`
 * hydration, so a doc that would only fail there (e.g. an unknown node type) is
 * rejected at preview time too (#154 review). Still cheap: no live fragment, no
 * `updateYFragment`.
 */
export function assertYjsEncodable(doc: any): void {
  buildYDoc(doc);
  const safe = sanitizeForYjs(doc);
  try {
    PMNode.fromJSON(docmostSchema, safe);
  } catch (e) {
    throw unstorableYjsError(safe, "fromJSON", e);
  }
}

/** Time we wait for the initial handshake/sync before giving up. */
const CONNECT_TIMEOUT_MS = 25000;
/** Time we wait for the server to acknowledge our write before giving up. */
const PERSIST_TIMEOUT_MS = 20000;

/**
 * Safely mutate the live content of a page over the collaboration websocket.
 *
 * This is the single safe write path for every MCP content mutation. It:
 *   1. serializes per-page writes through withPageLock (no two MCP writes on
 *      the same page overlap);
 *   2. connects to Hocuspocus and waits for the initial sync so the local ydoc
 *      mirrors the authoritative server doc — INCLUDING edits/comments/images
 *      that are not yet in the debounced REST snapshot;
 *   3. inside onSynced, SYNCHRONOUSLY reads the live doc, runs `transform`, and
 *      writes the result back — with no `await` between read and write so no
 *      remote update can interleave and clobber concurrent human edits;
 *   4. waits for the server to acknowledge the write (unsyncedChanges -> 0)
 *      before resolving, so the next operation observes our change.
 *
 * `transform` receives the live ProseMirror doc and returns the NEW full
 * ProseMirror doc to write, or `null` to abort with no write (a no-op). If
 * `transform` throws, the error is propagated to the caller (not swallowed).
 *
 * Resolves a `MutationResult { doc, verify }`: `doc` is the doc that was
 * written (or the live doc when the transform aborted), and `verify` is a
 * verifiable change report (text/block/mark deltas) of what actually changed.
 * The report is computed AFTER the atomic read->write, so it never widens the
 * read->write window, and it never throws (it can NEVER break a write).
 */
export async function mutatePageContent(
  pageId: string,
  collabToken: string,
  baseUrl: string,
  transform: (liveDoc: any) => any | null,
): Promise<MutationResult> {
  return withPageLock(pageId, () => {
    if (process.env.DEBUG) {
      console.error(`Starting realtime content mutate for page ${pageId}`);
      // Token prefix is sensitive; only log it under DEBUG.
      console.error(
        `Token prefix: ${collabToken ? collabToken.substring(0, 5) : "NONE"}...`,
      );
    }

    const ydoc = new Y.Doc();
    const wsUrl = buildCollabWsUrl(baseUrl);
    if (process.env.DEBUG) console.error(`Connecting to WebSocket: ${wsUrl}`);

    return new Promise<MutationResult>((resolve, reject) => {
      let provider: HocuspocusProvider | undefined;
      let applied = false; // onSynced may fire again on reconnect — apply once.
      let settled = false;
      // Set true on disconnect/close so a reconnect-driven unsyncedChanges->0
      // cannot be mistaken for a successful persist of our write.
      let connectionLost = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      let persistTimer: ReturnType<typeof setTimeout> | undefined;
      let unsyncedHandler: ((data: { number: number }) => void) | undefined;

      const cleanup = () => {
        if (connectTimer) clearTimeout(connectTimer);
        if (persistTimer) clearTimeout(persistTimer);
        if (provider) {
          if (unsyncedHandler) {
            try {
              provider.off("unsyncedChanges", unsyncedHandler);
            } catch (err) {}
          }
          try {
            provider.destroy();
          } catch (err) {}
        }
      };

      const finish = (err: Error | null, value?: MutationResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(value as MutationResult);
      };

      connectTimer = setTimeout(() => {
        finish(new Error("Connection timeout to collaboration server"));
      }, CONNECT_TIMEOUT_MS);

      // Resolve once the server has acknowledged our update. The provider
      // increments unsyncedChanges when our local update is sent and
      // decrements it when the server replies with a SyncStatus(applied=true);
      // reaching 0 means the authoritative in-memory ydoc on the server now
      // contains our write.
      const waitForPersistence = () => {
        if (settled) return;
        // A missing provider is a failure, not a success: without it the write
        // can never have been acknowledged. Only an actual unsyncedChanges===0
        // on a live provider counts as persisted.
        if (!provider) {
          finish(new Error("collab provider gone before persistence"));
          return;
        }
        if (provider.unsyncedChanges === 0) {
          finish(null, mutationResult);
          return;
        }
        persistTimer = setTimeout(() => {
          finish(
            new Error(
              "Timeout waiting for collaboration server to persist the update",
            ),
          );
        }, PERSIST_TIMEOUT_MS);
        unsyncedHandler = (data: { number: number }) => {
          // Only treat unsyncedChanges->0 as success when the connection is
          // still up. A transient disconnect + reconnect handshake can drive
          // the counter back to 0 without our write being re-transmitted; in
          // that case let the disconnect/close error win instead.
          if (data.number === 0 && !connectionLost) {
            finish(null, mutationResult);
          }
        };
        provider.on("unsyncedChanges", unsyncedHandler);
      };

      // The verifiable result resolved on every success/abort path. Set on
      // abort (no-op report) and after a real write (computed change report).
      let mutationResult: MutationResult;

      provider = new HocuspocusProvider({
        url: wsUrl,
        name: `page.${pageId}`,
        document: ydoc,
        token: collabToken,
        // @ts-ignore - Required for Node.js environment
        WebSocketPolyfill: WebSocket,
        onConnect: () => {
          if (process.env.DEBUG) console.error("WS Connect");
        },
        // An unexpected disconnect/close while we are still waiting (during the
        // connect-wait before onSynced, or during the persistence wait after the
        // write) means the update will never be acknowledged — surface it now
        // instead of hanging until the connect/persist timeout fires. `finish`
        // is idempotent via the `settled` flag, so the onClose that our own
        // cleanup()->provider.destroy() triggers (after settled=true is set) is
        // a harmless no-op and cannot cause a double-resolve.
        onDisconnect: () => {
          if (process.env.DEBUG) console.error("WS Disconnect");
          // Mark BEFORE finish so the unsyncedChanges handler (if it races)
          // sees the connection as lost and won't report a false success.
          connectionLost = true;
          finish(
            new Error(
              "Collaboration connection closed before the update was persisted/synced",
            ),
          );
        },
        onClose: () => {
          if (process.env.DEBUG) console.error("WS Close");
          // Mark BEFORE finish so the unsyncedChanges handler (if it races)
          // sees the connection as lost and won't report a false success.
          connectionLost = true;
          finish(
            new Error(
              "Collaboration connection closed before the update was persisted/synced",
            ),
          );
        },
        onSynced: () => {
          if (applied || settled) return;
          applied = true;
          if (process.env.DEBUG) console.error("Connected and synced!");

          // CRITICAL: everything between reading the live doc and writing it
          // back must stay synchronous (no await). While the JS event loop is
          // not yielded, no incoming remote update can interleave, so any
          // already-synced concurrent edits are preserved in liveDoc.
          let newDoc: any;
          let beforeDoc: any;
          try {
            let liveDoc = TiptapTransformer.fromYdoc(ydoc, "default");
            if (
              !liveDoc ||
              typeof liveDoc !== "object" ||
              !Array.isArray(liveDoc.content)
            ) {
              liveDoc = { type: "doc", content: [] };
            }

            // Snapshot the before-doc for the change report. Docs are
            // JSON-serializable, so this is a safe deep clone.
            beforeDoc = JSON.parse(JSON.stringify(liveDoc));

            newDoc = transform(liveDoc);

            if (newDoc == null) {
              // Transform aborted — write nothing, return the live doc with a
              // no-op change report.
              mutationResult = {
                doc: liveDoc,
                verify: {
                  changed: false,
                  textInserted: 0,
                  textDeleted: 0,
                  blocksChanged: 0,
                  marks: {},
                  summary: "no changes (transform aborted)",
                },
              };
              finish(null, mutationResult);
              return;
            }

            // Structural diff into the live fragment (issue #152): preserves
            // the Yjs ids of unchanged nodes, so an open editor's cursor is not
            // yanked to the end of the document on every agent write.
            applyDocToFragment(ydoc, newDoc);
          } catch (e) {
            // Includes errors thrown by transform (e.g. "afterText not found",
            // "text not found"): propagate them verbatim to the caller.
            finish(e instanceof Error ? e : new Error(String(e)));
            return;
          }

          // Compute the verifiable change report AFTER the transact write: it
          // only needs the JSON before/after, so it cannot affect the atomic
          // read->write window, and summarizeChange never throws.
          mutationResult = {
            doc: newDoc,
            verify: summarizeChange(beforeDoc, newDoc),
          };
          if (process.env.DEBUG)
            console.error("Content written, waiting for server to persist...");
          waitForPersistence();
        },
        onAuthenticationFailed: () => {
          finish(
            new Error("Authentication failed for collaboration connection"),
          );
        },
      });
    });
  });
}

/**
 * Replace the live content of a page over the collaboration websocket.
 * Accepts a ready ProseMirror JSON document; the caller controls whether
 * it was produced from markdown (ids regenerate) or edited in place
 * (existing block ids preserved).
 *
 * This is an intentional full replace (used by update_page / update_page_json),
 * but now runs under the per-page lock and waits for server persistence via
 * mutatePageContent.
 */
export async function replacePageContent(
  pageId: string,
  prosemirrorDoc: any,
  collabToken: string,
  baseUrl: string,
): Promise<MutationResult> {
  // Fail fast on a bad document instead of deferring the failure into the
  // collaboration write (where TiptapTransformer.toYdoc(undefined) used to
  // throw). The transform must return a valid ProseMirror doc.
  if (
    prosemirrorDoc == null ||
    typeof prosemirrorDoc !== "object" ||
    prosemirrorDoc.type !== "doc"
  ) {
    throw new Error("replacePageContent: invalid ProseMirror document");
  }
  return await mutatePageContent(
    pageId,
    collabToken,
    baseUrl,
    () => prosemirrorDoc,
  );
}

/**
 * Markdown update path (kept for backwards compatibility).
 * NOTE: this re-imports the whole document — block ids are regenerated.
 * Tables and :::callout::: blocks survive thanks to the full schema.
 */
export async function updatePageContentRealtime(
  pageId: string,
  markdownContent: string,
  collabToken: string,
  baseUrl: string,
): Promise<MutationResult> {
  // PAGE write: canonicalize footnotes (markdown import builds the bottom list in
  // definition order; numbering is reference-ordered).
  const tiptapJson = await markdownToProseMirrorCanonical(markdownContent);
  return await mutatePageContent(
    pageId,
    collabToken,
    baseUrl,
    () => tiptapJson,
  );
}
