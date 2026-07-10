/**
 * Public surface of the pure converter (`lib/`). This barrel re-exports the
 * PURE, IO-free pieces the sync engine needs: the self-contained markdown
 * (de)serializers, the lossless ProseMirror <-> Markdown converter, the
 * markdown -> ProseMirror import path, and semantic canonicalization for the
 * round-trip idempotency check (SPEC §11).
 *
 * There is no REST client, websocket/collab write-path, auth-utils or page-lock
 * here — the gitmost server writes natively.
 */
export {
  serializeDocmostMarkdown,
  parseDocmostMarkdown,
  serializeDocmostMarkdownBody,
} from "./markdown-document.js";
export type { DocmostMdMeta } from "./markdown-document.js";

export { convertProseMirrorToMarkdown } from "./markdown-converter.js";
export type { ConvertProseMirrorToMarkdownOptions } from "./markdown-converter.js";

export { markdownToProseMirror } from "./markdown-to-prosemirror.js";

// The Docmost tiptap schema mirror. Exposed so consumers (and the sync
// engine's schema-validity regression tests) can build the exact ProseMirror
// schema the converter targets.
export { docmostExtensions } from "./docmost-schema.js";

// Schema-adjacent sanitizers used by consumers (mcp) so the single canonical,
// alias-aware / allowlist implementations live ONLY here (no drifting copies).
export { clampCalloutType, sanitizeCssColor } from "./docmost-schema.js";

// Attached-comment convention (#293 canon #9/#4/#8): the reusable primitives
// the serializer/parser use to encode attrs that have no native markdown syntax
// as trailing `<!--name {json}-->` comments.
export {
  attachedCommentFor,
  standaloneCommentFor,
  parseAttachedComment,
} from "./attached-comment.js";
export type { AttachedComment } from "./attached-comment.js";

export {
  canonicalizeContent,
  docsCanonicallyEqual,
} from "./canonicalize.js";
export { parsePageFile, serializePageFile } from "./page-file.js";

// Pure, network-free helpers for manipulating a ProseMirror/TipTap document
// tree by node id (#414: the single canonical copy, formerly forked into mcp).
// Consumed by `@docmost/mcp` (patch/insert/delete node, table tools, outline).
export {
  blockPlainText,
  buildOutline,
  getNodeByRef,
  replaceNodeById,
  replaceNodeByIdWithMany,
  deleteNodeById,
  sanitizeForYjs,
  findUnstorableAttr,
  findInvalidNode,
  insertNodeRelative,
  insertNodesRelative,
  readTable,
  insertTableRow,
  deleteTableRow,
  updateTableCell,
  assertUnambiguousMatch,
} from "./node-ops.js";
export type { OutlineEntry } from "./node-ops.js";

// Normalize a ProseMirror node arg that the model may have serialized as a JSON
// string (#414: single copy shared by mcp and the CommonJS server app).
export { parseNodeArg } from "./parse-node-arg.js";

// Inline-footnote authoring convention (#414: single copy, formerly the mcp
// `footnote-authoring.ts` fork), shared with the importer's `assembleFootnotes`.
export {
  footnoteContentKey,
  makeFootnoteDefinition,
  generateFootnoteId,
} from "./footnote.js";
