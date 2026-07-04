// Guard: every tool the MCP server registers must be routed by intent in
// SERVER_INSTRUCTIONS — the editing guide clients receive in the initialize
// result. Without this, new tools silently rot out of the guide and agents
// never learn to pick them (the guide once omitted 17 of 41 tools, including
// get_outline, which pushed agents into fetching whole documents for block
// ids). Tool names are extracted from the SOURCE (index.ts inline
// registrations + tool-specs.ts shared specs) so a registration added either
// way is caught; the guide text itself is imported from the build so the test
// checks what actually ships.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SERVER_INSTRUCTIONS } from "../../build/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");

// Tools DELIBERATELY absent from the guide. Keep this list minimal and
// justify every entry — the default is: every tool gets routed.
const EXCEPTIONS = new Set([
  // Trivial and self-explanatory; carries no routing decision.
  "get_workspace",
]);

/**
 * Extract every registered tool name from the source. Two registration
 * mechanisms exist and both are covered:
 *  - inline `server.registerTool("name", ...)` calls in index.ts;
 *  - shared specs in tool-specs.ts (`mcpName: 'name'`), registered via
 *    registerShared(SHARED_TOOL_SPECS.x, ...).
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

test("every registered tool is mentioned in SERVER_INSTRUCTIONS", () => {
  const names = registeredToolNames();
  // Sanity: if extraction regressed (regex drift), fail loudly rather than
  // vacuously passing on an empty set.
  assert.ok(
    names.size >= 40,
    `sanity: expected to extract 40+ registered tools, got ${names.size} — ` +
      "the extraction regexes in this test likely drifted from the source",
  );
  const missing = [...names]
    .filter((n) => !EXCEPTIONS.has(n))
    // \b<name>\b: `_` is a word char, so \bget_page\b does NOT match inside
    // get_page_json — a tool can't hide behind a longer sibling's mention.
    .filter((n) => !new RegExp(`\\b${n}\\b`).test(SERVER_INSTRUCTIONS))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `tools missing from SERVER_INSTRUCTIONS: ${missing.join(", ")} — ` +
      "update the guide in packages/mcp/src/index.ts (see its MAINTENANCE " +
      "RULE comment), or add a justified entry to EXCEPTIONS here",
  );
});

test("EXCEPTIONS entries are real registered tools", () => {
  // A stale exception (tool renamed/removed) must be cleaned up, otherwise
  // the list quietly grows past its purpose.
  const names = registeredToolNames();
  for (const name of EXCEPTIONS) {
    assert.ok(
      names.has(name),
      `EXCEPTIONS entry "${name}" is not a registered tool — remove it`,
    );
  }
});
