// #502: the MCP markdown-WRITE path imports agent markdown with the two layered
// extensions turned OFF. This pins the behavior at the two write entry points
// that share the importer:
//   - markdownToProseMirrorCanonical  (createPage body + updatePageMarkdown)
//   - importMarkdownFragment          (patch_node / insert_node markdown fragment)
// so that a `$…$` span stays literal text (real math -> update_page_json) and a
// SCHEMELESS `www.host` is not autolinked, while an EXPLICIT `https://…` still
// links and block structure survives. It also asserts the PACKAGE default
// importer (used by editor/file-import/git-sync) is UNCHANGED (math ON), proving
// the write path — not the shared importer — is what turned the extensions off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToProseMirrorCanonical } from "../../build/lib/collaboration.js";
import { importMarkdownFragment } from "../../build/lib/markdown-fragment.js";
import { markdownToProseMirror } from "@docmost/prosemirror-markdown";

function findAll(node, type, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) findAll(c, type, acc);
  return acc;
}
function allText(node, acc = []) {
  if (!node || typeof node !== "object") return acc.join("");
  if (node.type === "text" && typeof node.text === "string") acc.push(node.text);
  if (Array.isArray(node.content)) for (const c of node.content) allText(c, acc);
  return acc.join("");
}
function hasLink(node) {
  return findAll(node, "text").some((t) => t.marks?.some((m) => m.type === "link"));
}

test("createPage/updatePageMarkdown importer: `$…$` config stays literal (no math)", async () => {
  const doc = await markdownToProseMirrorCanonical("export A=$FOO and B=$BAR done");
  assert.equal(findAll(doc, "mathInline").length, 0, "no phantom math node");
  assert.equal(allText(doc), "export A=$FOO and B=$BAR done");
});

test("createPage/updatePageMarkdown importer: schemeless www NOT linked; https STILL linked", async () => {
  const bare = await markdownToProseMirrorCanonical("see www.example.com here");
  assert.equal(hasLink(bare), false, "schemeless domain not autolinked");
  assert.equal(allText(bare), "see www.example.com here");

  const explicit = await markdownToProseMirrorCanonical("see https://example.com here");
  assert.equal(hasLink(explicit), true, "explicit https still links");
});

test("createPage/updatePageMarkdown importer: heading + list structure preserved", async () => {
  const doc = await markdownToProseMirrorCanonical("## Heading\n\n- one\n- two");
  assert.equal(findAll(doc, "heading").length, 1);
  assert.equal(findAll(doc, "bulletList").length, 1);
});

test("fragment importer (patch_node/insert_node): `$x=1$` stays literal, https links", async () => {
  const { blocks } = await importMarkdownFragment("cfg $x=1$ and https://ex.com");
  const doc = { type: "doc", content: blocks };
  assert.equal(findAll(doc, "mathInline").length, 0, "no math in fragment");
  assert.equal(hasLink(doc), true, "explicit https still links in fragment");
  assert.ok(allText(doc).includes("$x=1$"), "literal dollars preserved");
});

test("PACKAGE default importer is UNCHANGED (math ON) — editor/file/git-sync path", async () => {
  const doc = await markdownToProseMirror("$x^2$");
  assert.equal(findAll(doc, "mathInline").length, 1, "defaults keep math on");
});
