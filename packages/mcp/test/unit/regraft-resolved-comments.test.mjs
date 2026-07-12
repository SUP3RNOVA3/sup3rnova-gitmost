import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectResolvedCommentSpans,
  regraftResolvedComments,
  applyCommentMarkInDoc,
} from "../../build/lib/comment-anchor.js";

/**
 * #493 commit 6 — resolved-comment anchors must survive a full markdown rewrite
 * (updatePageMarkdown). An agent read HIDES resolved anchors (#337), so its
 * markdown drops them; a naive full write would erase the resolved comment marks.
 * `regraftResolvedComments(oldDoc, newDoc)` re-anchors them onto the matching
 * text. These exercise the real anchoring (no mock).
 */

const doc = (...content) => ({ type: "doc", content });
const para = (...content) => ({ type: "paragraph", content });
const text = (t, marks) => (marks ? { type: "text", text: t, marks } : { type: "text", text: t });
const resolvedComment = (commentId) => ({ type: "comment", attrs: { commentId, resolved: true } });
const activeComment = (commentId) => ({ type: "comment", attrs: { commentId, resolved: false } });

/** The comment mark on a text node, or null. */
function commentMarkOf(node) {
  const marks = Array.isArray(node?.marks) ? node.marks : [];
  return marks.find((m) => m && m.type === "comment") || null;
}
/** Flatten every text node in a doc (deep). */
function textNodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "text") out.push(node);
  if (Array.isArray(node.content)) for (const c of node.content) textNodes(c, out);
  return out;
}

test("collectResolvedCommentSpans: only resolved marks, concatenated across a run", () => {
  const old = doc(
    para(
      text("keep "),
      text("resolved bit", [resolvedComment("r1")]),
      text(" and "),
      text("active bit", [activeComment("a1")]),
    ),
  );
  const spans = collectResolvedCommentSpans(old);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].commentId, "r1");
  assert.equal(spans[0].text, "resolved bit");
  assert.equal(spans[0].mark.attrs.resolved, true);
});

test("regraft restores a resolved mark the agent's markdown dropped", () => {
  // OLD doc has a resolved comment on "important note".
  const old = doc(para(text("An "), text("important note", [resolvedComment("r1")]), text(" here.")));
  // NEW doc (re-imported from the agent's markdown) has the SAME text but NO
  // comment mark — the resolved anchor was hidden on read.
  const fresh = doc(para(text("An important note here.")));

  const out = regraftResolvedComments(old, fresh);
  // Inputs are not mutated.
  assert.equal(commentMarkOf(textNodes(fresh)[0]), null);
  // The resolved mark is back on exactly "important note".
  const marked = textNodes(out).filter((n) => commentMarkOf(n));
  assert.equal(marked.length, 1);
  assert.equal(marked[0].text, "important note");
  assert.equal(commentMarkOf(marked[0]).attrs.commentId, "r1");
  assert.equal(commentMarkOf(marked[0]).attrs.resolved, true);
});

test("a resolved span whose text the agent changed is dropped (no re-anchor)", () => {
  const old = doc(para(text("stale text", [resolvedComment("r1")])));
  const fresh = doc(para(text("completely rewritten body")));
  const out = regraftResolvedComments(old, fresh);
  assert.equal(textNodes(out).filter((n) => commentMarkOf(n)).length, 0);
});

test("regraft is a no-op when the old doc has no resolved comments", () => {
  const old = doc(para(text("plain "), text("active", [activeComment("a1")])));
  const fresh = doc(para(text("plain active")));
  const out = regraftResolvedComments(old, fresh);
  assert.equal(textNodes(out).filter((n) => commentMarkOf(n)).length, 0);
});

test("multiple distinct resolved comments are all restored", () => {
  const old = doc(
    para(text("first", [resolvedComment("r1")]), text(" middle "), text("second", [resolvedComment("r2")])),
  );
  const fresh = doc(para(text("first middle second")));
  const out = regraftResolvedComments(old, fresh);
  const byId = Object.fromEntries(
    textNodes(out)
      .filter((n) => commentMarkOf(n))
      .map((n) => [commentMarkOf(n).attrs.commentId, n.text]),
  );
  assert.equal(byId["r1"], "first");
  assert.equal(byId["r2"], "second");
});

test("applyCommentMarkInDoc preserves an arbitrary mark's attrs (resolved:true)", () => {
  const d = doc(para(text("anchor me somewhere")));
  const ok = applyCommentMarkInDoc(d, "anchor me", { type: "comment", attrs: { commentId: "x9", resolved: true } });
  assert.equal(ok, true);
  const marked = textNodes(d).filter((n) => commentMarkOf(n));
  assert.equal(marked[0].text, "anchor me");
  assert.equal(commentMarkOf(marked[0]).attrs.resolved, true);
});
