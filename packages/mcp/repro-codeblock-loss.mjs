// Repro for the disappearing-codeBlock incident (page dwzDdgPep2).
// Chain under test:
//   1. MCP createComment anchors a comment mark INSIDE a codeBlock
//      (applyCommentMarkInDoc has no schema awareness);
//   2. applyDocToFragment writes the poisoned doc into the live Y.Doc
//      (PMNode.fromJSON does not validate marks against parent nodes);
//   3. any schema-full materialization (browser ySyncPlugin / initProseMirrorDoc)
//      hits schema.node('codeBlock', ...) -> createChecked -> validContent ->
//      allowsMarks === false (codeBlock spec `marks: ""`) -> throw ->
//      y-prosemirror catch DELETES the codeBlock from the Y.Doc permanently.
import { docmostSchema } from "./build/lib/docmost-schema.js";
import { applyCommentMarkInDoc } from "./build/lib/comment-anchor.js";
import { buildYDoc, applyDocToFragment } from "./build/lib/collaboration.js";
import { yDocToProsemirrorJSON } from "y-prosemirror";
import { initProseMirrorDoc } from "y-prosemirror";

const countCodeBlocks = (doc) =>
  (doc.content || []).filter((n) => n.type === "codeBlock").length;

// 1. A page with a paragraph, a code block, and a trailing paragraph.
const doc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Пишем что-то вроде:" }] },
    {
      type: "codeBlock",
      attrs: { language: "c" },
      content: [{ type: "text", text: "static bool s_dirty_seen = false;\nint x = 1;" }],
    },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ],
};

const ydoc = buildYDoc(doc);
const before = yDocToProsemirrorJSON(ydoc, "default");
console.log("[1] codeBlocks in Y.Doc before poison:", countCodeBlocks(before));

// 2. Anchor a comment INSIDE the code block, like createComment does.
const poisoned = structuredClone(before);
const anchored = applyCommentMarkInDoc(
  poisoned,
  "s_dirty_seen",
  { type: "comment", attrs: { commentId: "test-comment-id", resolved: false } },
);
console.log("[2] applyCommentMarkInDoc anchored inside codeBlock:", anchored);

// 3. Write the poisoned doc back through the real MCP write path.
applyDocToFragment(ydoc, poisoned);
const mid = yDocToProsemirrorJSON(ydoc, "default");
const cb = (mid.content || []).find((n) => n.type === "codeBlock");
const hasMarkInside = JSON.stringify(cb || {}).includes("test-comment-id");
console.log("[3] after applyDocToFragment: codeBlocks =", countCodeBlocks(mid),
  "| comment mark inside codeBlock:", hasMarkInside);

// 4. Materialize like the browser editor does on page open (ySyncPlugin init).
const codeBlockSpec = docmostSchema.nodes.codeBlock.spec;
console.log("[4] schema codeBlock spec marks:", JSON.stringify(codeBlockSpec.marks));
initProseMirrorDoc(ydoc.getXmlFragment("default"), docmostSchema);

// 5. The Y.Doc itself after materialization: is the code block still there?
const after = yDocToProsemirrorJSON(ydoc, "default");
console.log("[5] codeBlocks in Y.Doc AFTER client materialization:", countCodeBlocks(after));
console.log("[5] block types now:", (after.content || []).map((n) => n.type).join(", "));
console.log(
  countCodeBlocks(after) === 0
    ? ">>> REPRODUCED: the codeBlock was permanently deleted from the Y.Doc <<<"
    : ">>> not reproduced <<<",
);
