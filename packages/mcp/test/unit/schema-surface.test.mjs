import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";

import { docmostExtensions } from "../../build/lib/docmost-schema.js";

// SCHEMA-DRIFT GUARD (must-review gate).
//
// `src/lib/docmost-schema.ts` is a VENDORED MIRROR of the canonical Docmost
// document schema defined in `@docmost/editor-ext`. The MCP server uses it to
// convert pages to/from ProseMirror JSON (and through Yjs); any node, mark, or
// attribute that exists in the canonical schema but is missing here is silently
// dropped on a round-trip (data loss). The reverse — a node/mark/attr here that
// no longer exists in the canonical schema — is dead surface that can mask drift.
//
// This test derives a stable, sorted "schema surface" (every node/mark name and
// its sorted attribute keys) and pins it against an INLINE expected constant.
// It is intentionally a LOUD must-review gate rather than an automatic
// editor-ext diff: editor-ext's Tiptap representation differs from this
// vendored copy, so a cross-representation compare would be fragile. The
// reference lives in this file so it is reviewed in the diff of every change.
//
// This is the MCP twin of git-sync's
// `packages/git-sync/test/schema-surface-snapshot.test.ts`. The two vendored
// copies are NOT identical (see PROVENANCE in docmost-schema.ts): the MCP copy
// does not vendor every node git-sync does, so the surfaces legitimately differ.
// Keep both gates honest against `@docmost/editor-ext` independently.
//
// WHEN THIS TEST FAILS: do NOT blindly update `expectedSurface`. First confirm
// the change matches `@docmost/editor-ext` (the canonical schema) so the
// markdown <-> ProseMirror round-trip stays lossless, THEN copy the new surface
// into the expected constant below.

/** Derive the deterministic schema surface from the vendored extension set. */
function deriveSurface() {
  const schema = getSchema(docmostExtensions);
  const surface = [];
  for (const [name, type] of Object.entries(schema.nodes)) {
    surface.push({
      name,
      kind: "node",
      attrs: Object.keys(type.spec?.attrs ?? {}).sort(),
    });
  }
  for (const [name, type] of Object.entries(schema.marks)) {
    surface.push({
      name,
      kind: "mark",
      attrs: Object.keys(type.spec?.attrs ?? {}).sort(),
    });
  }
  // Sort by name, then by kind, for a representation-independent ordering.
  surface.sort((a, b) =>
    a.name === b.name ? a.kind.localeCompare(b.kind) : a.name.localeCompare(b.name),
  );
  return surface;
}

// The committed reference surface. Built from the ACTUAL current schema; review
// every change to this constant against `@docmost/editor-ext`.
const expectedSurface = [
  { name: "attachment", kind: "node", attrs: ["attachmentId", "mime", "name", "placeholder", "size", "url"] },
  { name: "audio", kind: "node", attrs: ["attachmentId", "placeholder", "size", "src"] },
  { name: "blockquote", kind: "node", attrs: [] },
  { name: "bold", kind: "mark", attrs: [] },
  { name: "bulletList", kind: "node", attrs: [] },
  { name: "callout", kind: "node", attrs: ["icon", "type"] },
  { name: "code", kind: "mark", attrs: [] },
  { name: "codeBlock", kind: "node", attrs: ["language"] },
  { name: "column", kind: "node", attrs: ["width"] },
  { name: "columns", kind: "node", attrs: ["layout", "widthMode"] },
  { name: "comment", kind: "mark", attrs: ["commentId", "resolved"] },
  { name: "details", kind: "node", attrs: ["open"] },
  { name: "detailsContent", kind: "node", attrs: [] },
  { name: "detailsSummary", kind: "node", attrs: [] },
  { name: "doc", kind: "node", attrs: [] },
  { name: "drawio", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "height", "size", "src", "title", "width"] },
  { name: "embed", kind: "node", attrs: ["align", "height", "provider", "src", "width"] },
  { name: "excalidraw", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "height", "size", "src", "title", "width"] },
  { name: "footnoteDefinition", kind: "node", attrs: ["id"] },
  { name: "footnoteReference", kind: "node", attrs: ["id"] },
  { name: "footnotesList", kind: "node", attrs: [] },
  { name: "hardBreak", kind: "node", attrs: [] },
  { name: "heading", kind: "node", attrs: ["id", "indent", "level", "textAlign"] },
  { name: "highlight", kind: "mark", attrs: ["color"] },
  { name: "horizontalRule", kind: "node", attrs: [] },
  { name: "htmlEmbed", kind: "node", attrs: ["height", "source"] },
  { name: "image", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "height", "placeholder", "size", "src", "title", "width"] },
  { name: "italic", kind: "mark", attrs: [] },
  { name: "link", kind: "mark", attrs: ["class", "href", "internal", "rel", "target", "title"] },
  { name: "listItem", kind: "node", attrs: [] },
  { name: "mathBlock", kind: "node", attrs: ["text"] },
  { name: "mathInline", kind: "node", attrs: ["text"] },
  { name: "mention", kind: "node", attrs: ["anchorId", "creatorId", "entityId", "entityType", "id", "label", "slugId"] },
  { name: "orderedList", kind: "node", attrs: ["start", "type"] },
  { name: "pageBreak", kind: "node", attrs: [] },
  { name: "paragraph", kind: "node", attrs: ["id", "indent", "textAlign"] },
  { name: "pdf", kind: "node", attrs: ["attachmentId", "height", "name", "placeholder", "size", "src", "width"] },
  { name: "strike", kind: "mark", attrs: [] },
  { name: "subpages", kind: "node", attrs: [] },
  { name: "subscript", kind: "mark", attrs: [] },
  { name: "superscript", kind: "mark", attrs: [] },
  { name: "table", kind: "node", attrs: [] },
  { name: "tableCell", kind: "node", attrs: ["align", "backgroundColor", "backgroundColorName", "colspan", "colwidth", "rowspan"] },
  { name: "tableHeader", kind: "node", attrs: ["align", "backgroundColor", "backgroundColorName", "colspan", "colwidth", "rowspan"] },
  { name: "tableRow", kind: "node", attrs: [] },
  { name: "taskItem", kind: "node", attrs: ["checked"] },
  { name: "taskList", kind: "node", attrs: [] },
  { name: "text", kind: "node", attrs: [] },
  { name: "textStyle", kind: "mark", attrs: ["color"] },
  { name: "underline", kind: "mark", attrs: [] },
  { name: "video", kind: "node", attrs: ["align", "alt", "aspectRatio", "attachmentId", "height", "placeholder", "size", "src", "width"] },
  { name: "youtube", kind: "node", attrs: ["align", "height", "src", "width"] },
];

test("docmost schema surface matches the committed reference (re-verify against @docmost/editor-ext on change)", () => {
  assert.deepEqual(deriveSurface(), expectedSurface);
});
