import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";

import { docmostExtensions } from "../src/lib/docmost-schema.js";
import * as editorExt from "@docmost/editor-ext";

// CROSS-PACKAGE SCHEMA CONTRACT (data-loss-sensitive).
//
// `src/lib/docmost-schema.ts` is a hand-synced VENDORED MIRROR of the canonical
// Docmost schema in `@docmost/editor-ext`. The sibling `schema-surface-snapshot`
// test pins the mirror's FULL surface (names + attrs) against an inline
// reference, but that reference is hand-curated and does not mechanically tie to
// editor-ext. This test closes that gap from the other side: it reads the ACTUAL
// Tiptap node/mark definitions exported by `@docmost/editor-ext` and asserts the
// vendored mirror is a SUPERSET of their type NAMES — so a Docmost-specific node
// or mark added upstream that the mirror forgets to vendor fails CI loudly
// (otherwise it is silently dropped on the markdown <-> ProseMirror round-trip).
//
// LIMITATION (intentional, see schema-surface-snapshot.test.ts): this is a
// NAME-LEVEL contract only, not a full attribute-level structural compare.
// editor-ext's Tiptap representation (node views, commands, suggestion plugins,
// addGlobalAttributes spread across separate extensions) differs from this
// minimal mirror, so a mechanical attribute-by-attribute equality would be
// fragile and produce false drift. Attribute parity is guarded by the inline
// surface snapshot (reviewed in every diff); this test guards that no canonical
// node/mark TYPE goes unmirrored. StarterKit-provided types (paragraph, bold,
// heading, …) are contributed by @tiptap/starter-kit in the mirror rather than
// by editor-ext, so they are naturally covered by the mirror's superset.

/** Tiptap Node/Mark instances expose a `.name` and a `.type` of 'node'|'mark'. */
function isTiptapNodeOrMark(
  value: unknown,
): value is { name: string; type: "node" | "mark" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name: unknown }).name === "string" &&
    "type" in value &&
    ((value as { type: unknown }).type === "node" ||
      (value as { type: unknown }).type === "mark")
  );
}

/** The set of node/mark type names the vendored mirror actually registers. */
function vendoredNames(): Set<string> {
  const schema = getSchema(docmostExtensions as never);
  return new Set([
    ...Object.keys(schema.nodes),
    ...Object.keys(schema.marks),
  ]);
}

/** The Docmost-specific node/mark type names exported by @docmost/editor-ext. */
function editorExtNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(editorExt)) {
    if (isTiptapNodeOrMark(value)) names.add(value.name);
  }
  return names;
}

describe("docmost schema vs @docmost/editor-ext (name-level contract)", () => {
  it("exposes Tiptap node/mark definitions from editor-ext (guards against the import going dark)", () => {
    // If editor-ext ever stops exporting concrete node/mark objects (e.g. a
    // barrel refactor), this contract would vacuously pass — assert it found a
    // meaningful set so the test cannot silently become a no-op.
    expect(editorExtNames().size).toBeGreaterThan(5);
  });

  it("vendors every Docmost-specific node/mark type defined in editor-ext (no silently-dropped types)", () => {
    const vendored = vendoredNames();
    const missing = [...editorExtNames()].filter((n) => !vendored.has(n)).sort();
    // missing must be empty: any name here exists in editor-ext but NOT in the
    // vendored mirror, so documents using it would lose that node/mark on a
    // git-sync round-trip. Re-sync src/lib/docmost-schema.ts before clearing.
    expect(missing).toEqual([]);
  });
});
