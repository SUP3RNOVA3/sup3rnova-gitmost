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
import type { PageId } from "./page-id.js";
import {
  sanitizeForYjs,
  findUnstorableAttr,
  findInvalidNode,
} from "@docmost/prosemirror-markdown";
import { canonicalizeFootnotes } from "./footnote-canonicalize.js";
import { normalizeAndMergeFootnotes } from "./footnote-normalize-merge.js";
import { VerifyReport } from "./diff.js";
import { acquireCollabSession } from "./collab-session.js";

export { markdownToProseMirror };

/**
 * Build the descriptive error for an opaque Yjs encode failure ("Unexpected
 * content type"), shared by both encode paths (`buildYDoc` -> `toYdoc` and
 * `applyDocToFragment` -> `updateYFragment`) so the message wording stays in one
 * place. `label` names the stage that failed (diagnostic). `sanitizeForYjs`
 * already stripped `undefined` attrs, so a remaining failure is pinpointed via
 * `findUnstorableAttr`.
 *
 * Diagnostics precedence (#409): the dominant crash here is
 * `Unknown node type: undefined` — a nested node with an absent/unknown `type`
 * (a SHAPE problem, e.g. `{"text":"foo"}` missing `"type":"text"`). That points
 * at the node, not an attribute, so `findInvalidNode` is consulted FIRST and,
 * on a hit, yields a path-anchored node-shape message. Only when the document
 * shape is sound do we fall back to `findUnstorableAttr` (undefined/function/
 * symbol/bigint attr values); the generic "attribute likely holds a value Yjs
 * cannot store" sentence is the last resort.
 */
function unstorableYjsError(safe: any, label: string, e: unknown): Error {
  const base = `Failed to encode document to Yjs (${label}): ${e instanceof Error ? e.message : String(e)}.`;
  const badNode = findInvalidNode(safe);
  if (badNode) {
    return new Error(`${base} Invalid node: ${badNode.summary}`);
  }
  const bad = findUnstorableAttr(safe);
  return new Error(
    `${base}${bad ? ` Offending attribute: ${bad}.` : " A node/mark attribute likely holds a value Yjs cannot store (e.g. undefined)."}`,
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
 *     with every other full-document persist path (`updatePageJson`,
 *     `docmostTransform`, `insertFootnote`, …). Because the package output is
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
  // #419: normalize + merge glyph-forked footnote definitions BEFORE
  // canonicalizing, so the canonicalizer re-hangs references and drops the
  // now-orphaned duplicate definitions.
  return canonicalizeFootnotes(
    normalizeAndMergeFootnotes(await markdownToProseMirror(markdownContent)),
  );
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

/**
 * Safely mutate the live content of a page over the collaboration websocket.
 *
 * This is the single safe write path for every MCP content mutation. It:
 *   1. serializes per-page writes through withPageLock (no two MCP writes on
 *      the same page overlap);
 *   2. acquires a LIVE, synced CollabSession for the page (issue #400) — a
 *      cached provider whose local ydoc mirrors the authoritative server doc
 *      (INCLUDING edits/comments/images not yet in the debounced REST snapshot),
 *      reused across a series of edits instead of a fresh connect/auth/sync per
 *      call;
 *   3. SYNCHRONOUSLY reads the live doc, runs `transform`, and writes the result
 *      back — with no `await` between read and write so no remote update can
 *      interleave and clobber concurrent human edits (CollabSession.mutate);
 *   4. waits for the server to acknowledge the write (unsyncedChanges -> 0)
 *      before resolving, so the next operation observes our change.
 *
 * On any mutate failure the session is destroyed so the next call reconnects
 * fresh; the page lock is held for the whole acquire+mutate so the session's
 * synchronous read->write window never overlaps another MCP write on the page.
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
  // Canonical UUID only (#260/#435): the brand forces every caller to
  // resolvePageId() BEFORE this seam so the lock + CollabSession key can never
  // be a raw slugId.
  pageId: PageId,
  collabToken: string,
  baseUrl: string,
  transform: (liveDoc: any) => any | null,
  // #487: optional abort signal carrying the turn's Stop + the in-app tool
  // per-call cap. Checked as the PRE-COMMIT safe-point below (after the session
  // is acquired, immediately before the atomic read->write), so a Stop that
  // arrives during the connect/lock window stops THIS write from landing. See the
  // limitation note at the check.
  signal?: AbortSignal,
): Promise<MutationResult> {
  return withPageLock(pageId, async () => {
    if (process.env.DEBUG) {
      console.error(`Starting realtime content mutate for page ${pageId}`);
      // Token prefix is sensitive; only log it under DEBUG.
      console.error(
        `Token prefix: ${collabToken ? collabToken.substring(0, 5) : "NONE"}...`,
      );
    }

    const session = await acquireCollabSession(pageId, collabToken, baseUrl);
    try {
      // #487 PRE-COMMIT safe-point: if the turn was Stopped (or the in-app tool
      // per-call cap fired) after we acquired the collab session but before the
      // atomic write, throw NOW so this commit never runs. KNOWN LIMITATION
      // (#487): this only stops THIS commit — a write tool that already committed
      // an EARLIER call this turn leaves that op applied. Cancel guarantees "no
      // NEW commit starts", NOT "the write didn't land".
      signal?.throwIfAborted();
      return await session.mutate(transform);
    } catch (e) {
      // Drop the session on any failure so the next call reconnects fresh (this
      // also closes the "reconnect drove the counter to 0" false-success class).
      session.destroy("mutate failed");
      throw e;
    }
  });
}

/**
 * Replace the live content of a page over the collaboration websocket.
 * Accepts a ready ProseMirror JSON document; the caller controls whether
 * it was produced from markdown (ids regenerate) or edited in place
 * (existing block ids preserved).
 *
 * This is an intentional full replace (used by update_page / updatePageJson),
 * but now runs under the per-page lock and waits for server persistence via
 * mutatePageContent.
 */
export async function replacePageContent(
  pageId: PageId,
  prosemirrorDoc: any,
  collabToken: string,
  baseUrl: string,
  // #487: threaded straight to mutatePageContent's pre-commit safe-point.
  signal?: AbortSignal,
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
    signal,
  );
}

/**
 * Markdown update path (kept for backwards compatibility).
 * NOTE: this re-imports the whole document — block ids are regenerated.
 * Tables and :::callout::: blocks survive thanks to the full schema.
 */
export async function updatePageContentRealtime(
  pageId: PageId,
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
