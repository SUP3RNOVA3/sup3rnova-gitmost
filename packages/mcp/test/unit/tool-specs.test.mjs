import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { SHARED_TOOL_SPECS } from "../../build/tool-specs.js";

// The shared registry is consumed by BOTH the zod-v3 MCP server and the zod-v4
// in-app AI-SDK service, so every spec must carry the cross-layer wiring
// (mcpName + inAppKey) and its builders must produce the right field set when
// called with a real zod namespace.

test("every spec exposes mcpName + inAppKey, and the key matches inAppKey", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    assert.equal(typeof spec.mcpName, "string");
    assert.ok(spec.mcpName.length > 0, `${key}: empty mcpName`);
    assert.equal(typeof spec.inAppKey, "string");
    assert.ok(spec.inAppKey.length > 0, `${key}: empty inAppKey`);
    assert.equal(typeof spec.description, "string");
    assert.ok(spec.description.length > 0, `${key}: empty description`);
    // The registry is keyed by inAppKey — keep the two in sync.
    assert.equal(spec.inAppKey, key, `${key}: registry key must equal inAppKey`);
  }
});

test("mcpName uses snake_case and inAppKey uses camelCase", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    assert.match(spec.mcpName, /^[a-z0-9]+(_[a-z0-9]+)*$/, `${key}: mcpName not snake_case`);
    assert.match(spec.inAppKey, /^[a-z][a-zA-Z0-9]*$/, `${key}: inAppKey not camelCase`);
  }
});

test("mcpName and inAppKey are each unique across the registry", () => {
  const mcpNames = new Set();
  const inAppKeys = new Set();
  for (const spec of Object.values(SHARED_TOOL_SPECS)) {
    assert.ok(!mcpNames.has(spec.mcpName), `duplicate mcpName: ${spec.mcpName}`);
    assert.ok(!inAppKeys.has(spec.inAppKey), `duplicate inAppKey: ${spec.inAppKey}`);
    mcpNames.add(spec.mcpName);
    inAppKeys.add(spec.inAppKey);
  }
});

test("buildShape (when present) returns a usable ZodRawShape with a real zod", () => {
  for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
    if (!spec.buildShape) continue;
    const shape = spec.buildShape(z);
    assert.equal(typeof shape, "object");
    // Each field must be a real zod type so z.object(shape) compiles a schema.
    for (const [field, zt] of Object.entries(shape)) {
      assert.ok(
        zt && typeof zt.parse === "function",
        `${key}.${field}: not a zod type`,
      );
    }
    // The compiled object schema must parse a minimal valid input.
    assert.doesNotThrow(() => z.object(shape));
  }
});

test("editPageText builder produces { pageId, edits } and drops the stale strip-and-retry claim", () => {
  const spec = SHARED_TOOL_SPECS.editPageText;
  assert.equal(spec.mcpName, "edit_page_text");
  const shape = spec.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["edits", "pageId"]);
  // A valid edits batch parses.
  const schema = z.object(shape);
  const parsed = schema.parse({
    pageId: "p1",
    edits: [{ find: "teh", replace: "the" }],
  });
  assert.equal(parsed.pageId, "p1");
  assert.equal(parsed.edits.length, 1);
  // The canonical description must NOT carry the stale MCP strip-and-retry claim.
  assert.ok(
    !/strip-and-retry/i.test(spec.description),
    "editPageText description still claims strip-and-retry",
  );
  assert.match(spec.description, /REFUSED into\s+failed\[\]/);
});

test("getNode builder produces exactly { pageId, nodeId }", () => {
  const shape = SHARED_TOOL_SPECS.getNode.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["nodeId", "pageId"]);
});

test("patchNode spec exists, merges BOTH descriptions, builds { pageId, nodeId, node }", () => {
  const spec = SHARED_TOOL_SPECS.patchNode;
  assert.ok(spec, "patchNode spec missing");
  assert.equal(spec.mcpName, "patch_node");
  assert.equal(spec.inAppKey, "patchNode");

  // The canonical description must carry the key guidance from BOTH originals:
  //  - MCP-only: "WITHOUT resending the whole document" + the cheaper/safer note.
  //  - in-app-only: "keeps the same node id" + the "Reversible ... page history"
  //    framing the MCP copy lacked.
  assert.match(spec.description, /WITHOUT resending the whole document/);
  assert.match(spec.description, /Cheaper and safer/);
  assert.match(spec.description, /keeps the same node id/i);
  assert.match(spec.description, /Reversible/i);
  assert.match(spec.description, /page history/i);

  const shape = spec.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["node", "nodeId", "pageId"]);
  // A minimal valid input parses (node accepts an arbitrary object via z.any()).
  const parsed = z.object(shape).parse({
    pageId: "p1",
    nodeId: "n1",
    node: { type: "paragraph" },
  });
  assert.equal(parsed.pageId, "p1");
  assert.equal(parsed.nodeId, "n1");
});

test("insertNode spec exists, merges BOTH descriptions, builds the full anchor shape", () => {
  const spec = SHARED_TOOL_SPECS.insertNode;
  assert.ok(spec, "insertNode spec missing");
  assert.equal(spec.mcpName, "insert_node");
  assert.equal(spec.inAppKey, "insertNode");

  // Canonical description must keep BOTH sides' nuance:
  //  - in-app-only: "EXACTLY ONE of anchorNodeId or anchorText" + "Reversible".
  //  - MCP-only: the table-structure (tableRow/tableCell) insertion guidance.
  assert.match(spec.description, /EXACTLY ONE of anchorNodeId or anchorText/);
  assert.match(spec.description, /tableRow/);
  assert.match(spec.description, /append is top-level only/);
  assert.match(spec.description, /Reversible via page history/);

  const shape = spec.buildShape(z);
  assert.deepEqual(
    Object.keys(shape).sort(),
    ["anchorNodeId", "anchorText", "node", "pageId", "position"],
  );
  // before/after/append are the only accepted positions; anchors are optional.
  const schema = z.object(shape);
  assert.doesNotThrow(() =>
    schema.parse({ pageId: "p1", node: { type: "paragraph" }, position: "append" }),
  );
  assert.throws(() =>
    schema.parse({ pageId: "p1", node: {}, position: "sideways" }),
  );
});

test("no-arg specs (getWorkspace/listSpaces/listShares) omit buildShape", () => {
  for (const key of ["getWorkspace", "listSpaces", "listShares"]) {
    assert.equal(SHARED_TOOL_SPECS[key].buildShape, undefined, `${key} should be no-arg`);
  }
});

// #411: plain-Markdown full-body replace tool, paired with updatePageJson.
test("updatePageMarkdown spec exists, pairs with updatePageJson, builds { pageId, content, title }", () => {
  const spec = SHARED_TOOL_SPECS.updatePageMarkdown;
  assert.ok(spec, "updatePageMarkdown spec missing");
  assert.equal(spec.mcpName, "update_page_markdown");
  assert.equal(spec.inAppKey, "updatePageMarkdown");
  // Registered on BOTH hosts (a shared spec, no inAppOnly/mcpOnly flag).
  assert.notEqual(spec.inAppOnly, true);
  assert.notEqual(spec.mcpOnly, true);
  // Same tier as its JSON sibling.
  assert.equal(spec.tier, SHARED_TOOL_SPECS.updatePageJson.tier);
  const shape = spec.buildShape(z);
  assert.deepEqual(Object.keys(shape).sort(), ["content", "pageId", "title"]);
  // pageId + content required, title optional.
  const schema = z.object(shape);
  assert.doesNotThrow(() => schema.parse({ pageId: "p1", content: "# Hi" }));
  assert.throws(() => schema.parse({ pageId: "p1" }));
  // The description must flag the `^[...]` inline-footnote parse path so the
  // markdown->footnote canonicalization guarantee stays documented (#411).
  assert.match(spec.description, /\^\[/);
});

// #411: import_page_markdown is dropped from the EXTERNAL MCP surface but stays
// available to the in-app agent — encoded as inAppOnly on the shared spec.
test("importPageMarkdown spec is inAppOnly (removed from the external MCP surface, kept in-app)", () => {
  const spec = SHARED_TOOL_SPECS.importPageMarkdown;
  assert.ok(spec, "importPageMarkdown spec missing");
  assert.equal(spec.inAppOnly, true);
  // The spec + its client method are NOT deleted — only hidden from the MCP host.
  assert.equal(spec.mcpName, "import_page_markdown");
  assert.equal(spec.inAppKey, "importPageMarkdown");
});
