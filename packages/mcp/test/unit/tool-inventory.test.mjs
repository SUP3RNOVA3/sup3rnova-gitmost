// Guard: the GENERATED <tool_inventory> in SERVER_INSTRUCTIONS (issue #448)
// names every tool the server registers. The inventory is BUILT from the
// registry (SHARED_TOOL_SPECS' mcpName/catalogLine + INLINE_MCP_INVENTORY), so
// the shared-registry tools can never drift by construction; this test's job is
// to catch the ONE remaining manual list — INLINE_MCP_INVENTORY — falling out
// of sync with the inline `server.registerTool(...)` calls in index.ts.
//
// It also asserts the composed guide keeps its routing prose (the hand-written
// intent hints) and is a valid non-empty string — the structural guarantees the
// old name-scraper test (server-instructions.test.mjs, now deleted) carried,
// minus its now-redundant per-name prose scrape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  SERVER_INSTRUCTIONS,
  ROUTING_PROSE,
  buildToolInventoryLines,
} from "../../build/server-instructions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");

/**
 * Every tool name the MCP server registers, scraped from the SOURCE:
 *  - inline `server.registerTool("name", ...)` calls in index.ts;
 *  - shared specs in tool-specs.ts (`mcpName: 'name'`).
 * Same two registration mechanisms the old guard covered.
 */
function registeredToolNames() {
  const indexSrc = readFileSync(join(SRC, "index.ts"), "utf8");
  const specsSrc = readFileSync(join(SRC, "tool-specs.ts"), "utf8");
  const names = new Set();
  for (const m of indexSrc.matchAll(/registerTool\(\s*"([a-z0-9_]+)"/g)) {
    names.add(m[1]);
  }
  for (const m of specsSrc.matchAll(/mcpName:\s*['"]([a-z0-9_]+)['"]/g)) {
    names.add(m[1]);
  }
  return names;
}

test("the generated inventory names every registered tool", () => {
  const registered = registeredToolNames();
  // Sanity: if the scrape regressed (regex drift), fail loudly rather than
  // vacuously passing on an empty set.
  assert.ok(
    registered.size >= 40,
    `sanity: expected 40+ registered tools, got ${registered.size} — ` +
      "the extraction regexes in this test likely drifted from the source",
  );
  const inventory = new Set(buildToolInventoryLines().map((l) => l.name));
  const missing = [...registered].filter((n) => !inventory.has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `tools missing from the generated <tool_inventory>: ${missing.join(", ")} — ` +
      "a SHARED spec is covered automatically; an INLINE MCP-only tool needs a " +
      "line added to INLINE_MCP_INVENTORY in src/server-instructions.ts",
  );
});

test("the inventory has no phantom tool (every line is a real registered tool)", () => {
  const registered = registeredToolNames();
  const phantom = buildToolInventoryLines()
    .map((l) => l.name)
    .filter((n) => !registered.has(n))
    .sort();
  assert.deepEqual(
    phantom,
    [],
    `<tool_inventory> lists tools that are NOT registered: ${phantom.join(", ")}`,
  );
});

test("every inventory line has a non-empty purpose", () => {
  for (const line of buildToolInventoryLines()) {
    assert.equal(typeof line.purpose, "string");
    assert.ok(line.purpose.trim().length > 0, `${line.name}: empty purpose`);
  }
});

test("SERVER_INSTRUCTIONS keeps the routing prose and the generated inventory", () => {
  assert.equal(typeof SERVER_INSTRUCTIONS, "string");
  assert.ok(SERVER_INSTRUCTIONS.length > 0, "SERVER_INSTRUCTIONS is empty");
  // Routing prose is spliced in verbatim (the hand-written intent hints).
  assert.ok(
    SERVER_INSTRUCTIONS.startsWith(ROUTING_PROSE),
    "the routing prose is not preserved at the head of the guide",
  );
  // The generated inventory block is present.
  assert.match(SERVER_INSTRUCTIONS, /<tool_inventory>/);
  assert.match(SERVER_INSTRUCTIONS, /<\/tool_inventory>/);
  // The routing families are still present in the prose.
  for (const family of ["READ:", "EDIT:", "PAGES:", "COMMENTS:", "HISTORY:"]) {
    assert.ok(
      SERVER_INSTRUCTIONS.includes(family),
      `routing prose lost its ${family} section`,
    );
  }
});
