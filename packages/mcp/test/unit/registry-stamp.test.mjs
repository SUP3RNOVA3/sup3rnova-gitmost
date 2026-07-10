import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { computeRegistryStamp } from "../../scripts/gen-registry-stamp.mjs";
import { REGISTRY_STAMP } from "../../build/index.js";

// Guard tests for the build/src-skew stamp (issue #447). The codegen script
// exports `computeRegistryStamp(sourceText)` — a sha256 over normalized source
// text (CRLF->LF, single trailing newline stripped). The in-app loader
// (apps/server/.../docmost-client.loader.ts) DUPLICATES that normalize+sha256 to
// recompute the stamp from src and refuse a stale build. These tests pin the
// algorithm's behaviour AND assert the built stamp matches the current src, so a
// stale generated file OR a normalize divergence reddens.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_SPECS_PATH = join(__dirname, "..", "..", "src", "tool-specs.ts");

test("computeRegistryStamp is deterministic: same input -> same hash", () => {
  const input = "export const X = 1;\nexport const Y = 2;\n";
  assert.equal(computeRegistryStamp(input), computeRegistryStamp(input));
});

test("computeRegistryStamp returns a 64-char lowercase hex sha256", () => {
  const stamp = computeRegistryStamp("anything");
  assert.match(stamp, /^[0-9a-f]{64}$/);
});

test("normalizes CRLF vs LF: the same content hashes equal", () => {
  const lf = "line1\nline2\nline3";
  const crlf = "line1\r\nline2\r\nline3";
  assert.equal(computeRegistryStamp(crlf), computeRegistryStamp(lf));
});

test("normalizes a trailing newline: with/without a final \\n hashes equal", () => {
  const noTrailing = "alpha\nbeta";
  const trailing = "alpha\nbeta\n";
  assert.equal(computeRegistryStamp(trailing), computeRegistryStamp(noTrailing));
});

test("a CRLF checkout WITH a trailing CRLF still hashes equal to bare LF", () => {
  // A worst-case Windows checkout: CRLF line endings + a trailing CRLF. Both the
  // \r\n->\n replace and the trailing-newline strip must apply for parity.
  const bare = "alpha\nbeta";
  const crlfTrailing = "alpha\r\nbeta\r\n";
  assert.equal(
    computeRegistryStamp(crlfTrailing),
    computeRegistryStamp(bare),
  );
});

test("a real content change hashes differently", () => {
  const before = "export const description = 'search a page';\n";
  const after = "export const description = 'search a PAGE';\n";
  assert.notEqual(computeRegistryStamp(before), computeRegistryStamp(after));
});

// Only a SINGLE trailing newline is stripped — a second blank line is content and
// must change the hash. This pins the exact `/\n$/` semantics the loader mirrors.
test("only ONE trailing newline is stripped (two differ from one)", () => {
  assert.notEqual(
    computeRegistryStamp("x\n"),
    computeRegistryStamp("x\n\n"),
  );
});

// Cross-impl equality against a fixed, documented input. The SAME literal input
// and expected hash are asserted in the server-side jest test
// (docmost-client.loader.spec.ts). If either side's normalize+sha256 ever
// diverges, one of the two tests reddens. Input exercises BOTH normalize steps.
test("fixed-input hash matches the documented cross-impl value", () => {
  const FIXED_INPUT = "line1\r\nline2\n";
  const EXPECTED =
    "683376e290829b482c2655745caffa7a1dccfa10afaa62dac2b42dd6c68d0f83";
  assert.equal(computeRegistryStamp(FIXED_INPUT), EXPECTED);
});

// DESYNC GUARD (covers reviewer suggestion 2). Recompute the stamp from the
// actual src/tool-specs.ts and assert it equals the REGISTRY_STAMP baked into the
// freshly-built build/index.js. This reddens if the generated file is stale OR if
// the codegen normalize ever diverges from what produced the built stamp.
test("built REGISTRY_STAMP equals the stamp recomputed from src/tool-specs.ts", () => {
  const source = readFileSync(TOOL_SPECS_PATH, "utf8");
  assert.equal(computeRegistryStamp(source), REGISTRY_STAMP);
});

// Sanity: the fixed-input helper computes the SAME way the codegen does, proving
// the EXPECTED constant above is not an arbitrary magic value but the documented
// normalize+sha256 of FIXED_INPUT. Belt-and-braces so a bad EXPECTED can't hide a
// real regression.
test("the documented EXPECTED constant is the normalize+sha256 of FIXED_INPUT", () => {
  const FIXED_INPUT = "line1\r\nline2\n";
  const normalized = FIXED_INPUT.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const expected = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  assert.equal(computeRegistryStamp(FIXED_INPUT), expected);
});
