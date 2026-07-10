// Issue #464 — prod CPU-DoS pre-flight size guard for diffDocs.
//
// diffDocs synchronously calls recreateTransform (rfc6902) which is O(n·m) in
// node count and O(w²) in per-run word count; on a large/heavily-changed doc it
// pins the event loop for seconds-to-hours WITHOUT throwing. A pre-flight size
// guard routes any doc over MCP_DIFF_MAX_NODES / MCP_DIFF_MAX_BYTES straight to
// the coarse fallback (`fellBack:true`), so the sync block stays ~<200ms.
//
// These tests assert the BEHAVIOR of the guard (fast + coarse-mode + asymmetry +
// env knobs). A sibling test (diff-guard-skips-recreate.test.mjs) proves
// recreateTransform is skipped over the cap via a behavioral proxy (guarded run
// is orders of magnitude faster than the same pair with the caps raised).
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDocs } from "../../build/lib/diff.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const t = (text) => ({ type: "text", text });
const para = (text) => ({ type: "paragraph", content: text ? [t(text)] : [] });
const doc = (children) => ({ type: "doc", content: children });

/** A doc of `n` paragraphs whose words are seeded from `seed` (fully changeable). */
function buildDoc(n, wordsPerPara, seed) {
  const blocks = [];
  for (let i = 0; i < n; i++) {
    const words = [];
    for (let w = 0; w < wordsPerPara; w++) words.push(`${seed}${i}_${w}`);
    blocks.push(para(words.join(" ")));
  }
  return doc(blocks);
}

/** Reset the env knobs to their unset default between tests. */
function clearEnv() {
  delete process.env.MCP_DIFF_MAX_NODES;
  delete process.env.MCP_DIFF_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Over-threshold (by node count) -> FAST + coarse mode.
// A fully re-written 600-para doc is the worst case that drove the incident;
// with the guard it must return in well under the ~200ms budget and in coarse
// mode. Without the guard this single call takes multiple SECONDS.
// ---------------------------------------------------------------------------
test("over-threshold doc falls back to coarse mode and returns fast", () => {
  clearEnv();
  // 600 paragraphs -> ~1200 nodes, far over the 150-node default.
  const oldDoc = buildDoc(600, 8, "a");
  const newDoc = buildDoc(600, 8, "b");

  const start = performance.now();
  const r = diffDocs(oldDoc, newDoc);
  const elapsed = performance.now() - start;

  // Coarse mode is signalled in the markdown note (fellBack path).
  assert.match(
    r.markdown,
    /coarse block-level diff/,
    "over-threshold pair must use the coarse fallback",
  );
  // Budget: the guard makes this near-instant. Generous 1s ceiling to avoid CI
  // flake while still being ~10x under the multi-second un-guarded cost.
  assert.ok(
    elapsed < 1000,
    `expected fast coarse fallback, took ${elapsed.toFixed(0)}ms`,
  );
  // Coarse diff still detects the wholesale change.
  assert.ok(r.summary.inserted > 0 || r.summary.deleted > 0, "reports changes");
});

// ---------------------------------------------------------------------------
// Under-threshold (small) doc -> precise diff, NOT coarse mode. No regression.
// ---------------------------------------------------------------------------
test("under-threshold doc uses the precise diff (no fallback note)", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);
  const r = diffDocs(oldDoc, newDoc);

  assert.doesNotMatch(
    r.markdown,
    /coarse block-level diff/,
    "a small doc must take the precise path",
  );
  // Precise word diff finds exactly the inserted word.
  const ins = r.changes.find((c) => c.op === "insert");
  assert.ok(ins && /brave/.test(ins.text), "precise diff isolates the inserted word");
});

// ---------------------------------------------------------------------------
// Asymmetry: a small NEW doc vs a huge OLD doc (and vice versa) still explodes
// rfc6902, so max(old,new) must trip the guard in BOTH directions.
// ---------------------------------------------------------------------------
test("asymmetric pair (huge old, tiny new) falls back to coarse", () => {
  clearEnv();
  const hugeOld = buildDoc(600, 8, "a");
  const tinyNew = doc([para("just one line")]);
  const r = diffDocs(hugeOld, tinyNew);
  assert.match(r.markdown, /coarse block-level diff/, "huge-old side must trip the guard");
});

test("asymmetric pair (tiny old, huge new) falls back to coarse", () => {
  clearEnv();
  const tinyOld = doc([para("just one line")]);
  const hugeNew = buildDoc(600, 8, "b");
  const r = diffDocs(tinyOld, hugeNew);
  assert.match(r.markdown, /coarse block-level diff/, "huge-new side must trip the guard");
});

// ---------------------------------------------------------------------------
// Byte axis: a FEW nodes but a very large serialized size (long text runs) is
// dangerous too (per-run word diff is O(words²)), so the byte cap must trip
// independently of the node count.
// ---------------------------------------------------------------------------
test("node-light but byte-heavy doc falls back on the byte cap", () => {
  clearEnv();
  // 5 paragraphs (~11 nodes, well under the node cap) but each a very long run,
  // pushing the serialized size far over the 12 KiB byte default.
  const bigRun = (seed) =>
    doc(
      Array.from({ length: 5 }, (_, i) =>
        para(Array.from({ length: 800 }, (_, w) => `${seed}${i}_${w}`).join(" ")),
      ),
    );
  const oldDoc = bigRun("a");
  const newDoc = bigRun("b");
  // Sanity: node count is under the default node cap, so ONLY the byte cap can
  // be what trips the guard here.
  const nodeCount = (d) => {
    let n = 0;
    const v = (x) => {
      if (!x || typeof x !== "object") return;
      n++;
      if (Array.isArray(x.content)) for (const c of x.content) v(c);
    };
    v(d);
    return n;
  };
  assert.ok(nodeCount(oldDoc) < 150, "node count is under the node cap");
  assert.ok(JSON.stringify(oldDoc).length > 12 * 1024, "serialized size is over the byte cap");

  const r = diffDocs(oldDoc, newDoc);
  assert.match(r.markdown, /coarse block-level diff/, "byte cap must trip independently");
});

// ---------------------------------------------------------------------------
// Env override: a very low MCP_DIFF_MAX_NODES forces fallback on a tiny doc,
// proving the knob is read fresh and actually gates the diff.
// ---------------------------------------------------------------------------
test("MCP_DIFF_MAX_NODES override forces fallback on a small doc", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);

  // Baseline: default caps -> precise diff.
  assert.doesNotMatch(diffDocs(oldDoc, newDoc).markdown, /coarse block-level diff/);

  // Knob set absurdly low -> even this 4-node doc trips the guard.
  process.env.MCP_DIFF_MAX_NODES = "1";
  try {
    const r = diffDocs(oldDoc, newDoc);
    assert.match(r.markdown, /coarse block-level diff/, "low node cap forces fallback");
  } finally {
    clearEnv();
  }
});

test("MCP_DIFF_MAX_BYTES override forces fallback on a small doc", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);

  process.env.MCP_DIFF_MAX_BYTES = "1";
  try {
    const r = diffDocs(oldDoc, newDoc);
    assert.match(r.markdown, /coarse block-level diff/, "low byte cap forces fallback");
  } finally {
    clearEnv();
  }
});

// ---------------------------------------------------------------------------
// Garbage / unset env values fall back to the DEFAULT (the guard can never be
// accidentally disabled by a malformed knob). A small doc must still diff
// precisely under a garbage cap.
// ---------------------------------------------------------------------------
test("garbage env values fall back to the default cap (guard not disabled)", () => {
  clearEnv();
  const oldDoc = doc([para("Hello world")]);
  const newDoc = doc([para("Hello brave world")]);

  for (const bad of ["not-a-number", "0", "-5", "", "NaN", "1e999"]) {
    process.env.MCP_DIFF_MAX_NODES = bad;
    process.env.MCP_DIFF_MAX_BYTES = bad;
    // Under the DEFAULT caps this small doc is precise (garbage did not raise
    // OR disable the cap). "1e999" -> parseInt yields 1 (finite) which is a
    // valid low cap and would fall back; exclude that from the precise check.
    const r = diffDocs(oldDoc, newDoc);
    if (bad === "1e999") {
      // parseInt("1e999",10) === 1 -> a legit low cap -> fallback. Guard active.
      assert.match(r.markdown, /coarse block-level diff/);
    } else {
      assert.doesNotMatch(
        r.markdown,
        /coarse block-level diff/,
        `garbage value ${JSON.stringify(bad)} must fall back to the default cap`,
      );
    }
  }
  clearEnv();
});

// ---------------------------------------------------------------------------
// A large doc that trips the guard must still return the correct INTEGRITY
// counts (computeIntegrity runs before the diff and is unaffected by fallback).
// ---------------------------------------------------------------------------
test("integrity counts are still correct on a guard-tripped (coarse) doc", () => {
  clearEnv();
  const image = { type: "image", attrs: { src: "/api/files/a.png" } };
  const oldDoc = doc([image, ...buildDoc(600, 8, "a").content]);
  const newDoc = doc([...buildDoc(600, 8, "b").content]); // image removed

  const r = diffDocs(oldDoc, newDoc);
  assert.match(r.markdown, /coarse block-level diff/, "large pair fell back");
  assert.deepEqual(r.integrity.images, [1, 0], "integrity is computed regardless of fallback");
});
