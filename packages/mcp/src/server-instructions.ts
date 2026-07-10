// SERVER_INSTRUCTIONS — the editing guide surfaced to MCP clients in the
// initialize result so they can pick the right tool by intent and avoid
// resending whole documents.
//
// This guide is split into TWO parts that are composed at the bottom:
//
//  1. ROUTING_PROSE — the hand-written "when to use what" intent hints (READ /
//     EDIT / PAGES / COMMENTS / HISTORY). This is legitimately manual: it
//     encodes editorial judgement (which tool for which situation, the cheap-
//     first ordering, the guardrail nudges) that cannot be derived from the
//     registry. It is NOT the drift-guard for the tool set.
//
//  2. A GENERATED <tool_inventory> — every tool the server registers, listed
//     by name + one-line purpose, grouped by family, built from the SAME
//     registry the server registers tools from (SHARED_TOOL_SPECS' mcpName +
//     catalogLine) PLUS the handful of inline MCP-only tools (their inventory
//     lines live in INLINE_MCP_INVENTORY below). Because this list is BUILT
//     from the registry, it can never drift out of sync with the registered
//     tools — adding/renaming/removing a spec changes it automatically, with no
//     prose edit and no scraper test. An unmapped tool still appears (under
//     "OTHER"), so a new tool can never silently vanish from the guide.
//
// This replaces the old hand-maintained monolithic guide + its regex scraper
// test (test/unit/server-instructions.test.mjs), which only checked that every
// registered name appeared SOMEWHERE in the prose and drifted whenever a name
// was reworded.
//
// OUT OF SCOPE (issue #448): the README / README.ru tool catalogs are still
// hand-maintained prose and are NOT generated from this registry. Regenerating
// them from SHARED_TOOL_SPECS is tracked separately as an optional docs script
// under issue #412 — until then a tool rename still needs a manual README edit.

import { SHARED_TOOL_SPECS, SharedToolSpec } from "./tool-specs.js";

/**
 * The hand-written routing prose — the intent hints that tell a client which
 * tool to reach for in which situation. Kept manual on purpose (it encodes
 * editorial judgement, not a mechanical name list). The generated inventory
 * below is spliced in after it.
 */
export const ROUTING_PROSE =
  "Docmost editing guide — choose the tool by intent. The <tool_inventory> at the end lists every tool with a one-line purpose; the notes below are the routing hints for WHEN to reach for each.\n" +
  "READ: find a page -> search (workspace-wide full-text); list -> list_pages / list_spaces. Locate blocks and their ids CHEAPLY -> get_outline (compact top-level map; start here, not get_page_json). One block's subtree -> get_node (by attrs.id, or \"#<index>\" for tables, which carry no id). Find every occurrence of a string/regex ON a page (and where each is) -> search_in_page, NOT block-by-block get_node — it returns each hit's node ref + block index + context for a targeted comment. Whole page -> get_page (Markdown, lossy; inline <span data-comment-id> tags are comment anchors — markup, not text) or get_page_json (lossless ProseMirror with block ids). Hand a huge page (with images) to an external consumer without pulling it through the model context -> stash_page (returns a short-lived anonymous URL).\n" +
  "EDIT: fix wording/typos/numbers -> edit_page_text (find/replace inside blocks, no node id needed). Change ONE block (paragraph/heading/callout/etc.) structurally -> patch_node (by attrs.id from get_outline). Add a block -> insert_node (before/after a block by attrs.id or by anchor text, or append). Remove a block -> delete_node (by attrs.id). Tables -> table_get / table_update_cell / table_insert_row / table_delete_row (address by \"#<index>\" from get_outline; table nodes have no attrs.id). Images -> insert_image (add from a web URL) / replace_image (swap an existing image). Draw.io diagrams -> drawio_create (create from mxGraph XML and insert), drawio_get (read a diagram as mxGraph XML + a hash), drawio_update (replace a diagram; pass the hash from drawio_get as baseHash for optimistic locking); before authoring a diagram, drawio_shapes (look up verified stencil style-strings so a shape name never renders as an empty box) and drawio_guide (on-demand authoring reference: skeleton/layout/containers/icons-aws/icons-azure), and pass layout:\"elk\" to drawio_create/drawio_update to auto-place nodes. Footnotes -> insert_footnote. Bulk/structural rewrite -> update_page_json (full ProseMirror replace) or update_page_markdown (full plain-Markdown body replace, re-imported — block ids regenerate); prefer the granular tools above to avoid resending the whole ~100KB+ document. Complex/scripted rewrite (multiple coordinated edits, renumbering) -> docmost_transform: write a JS `(doc, ctx) => doc` transform, preview the diff with dryRun (default), then apply with dryRun:false; ctx.helpers includes commentsToFootnotes for turning inline comments into numbered footnotes.\n" +
  "PAGES: new -> create_page (Markdown). Rename (title only) -> rename_page. Move -> move_page. Delete -> delete_page (SOFT delete — the page goes to trash and is restorable; nothing is permanent). Copy/replace a page's whole content from another page (server-side, no document through the model) -> copy_page_content. Sharing -> share_page / unshare_page / list_shares; share_page makes the page PUBLICLY accessible — do it only when explicitly asked.\n" +
  "COMMENTS: create_comment is always inline and requires an EXACT selection — contiguous text from a single block, <=250 chars (fails rather than leaving an unanchored comment); reply to a thread via parentCommentId. Propose a concrete text fix for one-click human approval -> create_comment with suggestedText (the exact plain-text replacement for the selection; the selection must then be UNIQUE in the page — extend it with context if needed); prefer this over editing directly when the change is subjective or needs the author's sign-off. Manage -> list_comments, update_comment, resolve_comment (resolve/reopen, reversible — prefer over delete to close), delete_comment, check_new_comments.\n" +
  "HISTORY: review what changed -> diff_page_versions (a historyId vs current, or two versions). List saved versions -> list_page_history. Undo a bad edit -> restore_page_version (writes a past version back as current; itself revertible). Export a page to self-contained Docmost Markdown (with comment anchors) -> export_page_markdown.";

/**
 * A single generated inventory line: the tool's registered NAME + a one-line
 * purpose. For a registry tool the purpose is its `catalogLine` (falling back
 * to the first sentence of its description); for an inline MCP-only tool it is
 * the hand-written line in INLINE_MCP_INVENTORY.
 */
export interface ToolInventoryLine {
  name: string;
  purpose: string;
}

/**
 * The families the inventory is grouped under, in display order. A tool is
 * placed by looking its mcpName up in TOOL_FAMILY; anything not listed there
 * falls into "OTHER" so it is never dropped from the guide.
 */
const FAMILY_ORDER = [
  "READ",
  "EDIT",
  "PAGES",
  "COMMENTS",
  "HISTORY",
  "OTHER",
] as const;
type Family = (typeof FAMILY_ORDER)[number];

/**
 * mcpName -> family for the generated inventory grouping. Purely cosmetic (it
 * orders the inventory to mirror the routing prose); an unmapped tool still
 * appears under OTHER, so forgetting to add an entry here can never drop a tool
 * from the guide — it only lands it in the catch-all group.
 */
const TOOL_FAMILY: Record<string, Family> = {
  // READ
  search: "READ",
  list_pages: "READ",
  list_spaces: "READ",
  get_outline: "READ",
  get_node: "READ",
  search_in_page: "READ",
  get_page: "READ",
  get_page_json: "READ",
  get_workspace: "READ",
  stash_page: "READ",
  // EDIT
  edit_page_text: "EDIT",
  patch_node: "EDIT",
  insert_node: "EDIT",
  delete_node: "EDIT",
  update_page_json: "EDIT",
  update_page_markdown: "EDIT",
  table_get: "EDIT",
  table_update_cell: "EDIT",
  table_insert_row: "EDIT",
  table_delete_row: "EDIT",
  insert_image: "EDIT",
  replace_image: "EDIT",
  insert_footnote: "EDIT",
  drawio_get: "EDIT",
  drawio_create: "EDIT",
  drawio_update: "EDIT",
  drawio_shapes: "EDIT",
  drawio_guide: "EDIT",
  docmost_transform: "EDIT",
  // PAGES
  create_page: "PAGES",
  rename_page: "PAGES",
  move_page: "PAGES",
  delete_page: "PAGES",
  copy_page_content: "PAGES",
  share_page: "PAGES",
  unshare_page: "PAGES",
  list_shares: "PAGES",
  // COMMENTS
  create_comment: "COMMENTS",
  list_comments: "COMMENTS",
  update_comment: "COMMENTS",
  resolve_comment: "COMMENTS",
  delete_comment: "COMMENTS",
  check_new_comments: "COMMENTS",
  // HISTORY
  diff_page_versions: "HISTORY",
  list_page_history: "HISTORY",
  restore_page_version: "HISTORY",
  export_page_markdown: "HISTORY",
  // import_page_markdown is now inAppOnly (#411) — it is not registered on the
  // external MCP host, so it no longer appears in the generated inventory.
};

/**
 * Inventory lines for the INLINE MCP-only tools — the ones registered directly
 * in index.ts (not via SHARED_TOOL_SPECS) because they diverge per transport or
 * exist only on this standalone surface. They carry no `catalogLine`, so their
 * one-line purpose is hand-written here. This is the ONLY hand-maintained tool
 * list left, and it is tiny; a new inline tool without an entry here is caught
 * by the completeness guard in `tool-inventory.test.mjs`.
 */
export const INLINE_MCP_INVENTORY: ToolInventoryLine[] = [
  {
    name: "table_get",
    purpose:
      "read a table as a matrix of cell texts + per-cell paragraph ids.",
  },
  {
    name: "search",
    purpose:
      "full-text search for pages and content across the whole workspace.",
  },
  {
    name: "docmost_transform",
    purpose:
      "edit a page by running a sandboxed JS `(doc, ctx) => doc` transform, with a dryRun diff preview.",
  },
  {
    name: "update_comment",
    purpose: "update an existing comment's content (creator only).",
  },
  {
    name: "delete_comment",
    purpose: "delete a comment (creator or space admin only).",
  },
];

/**
 * Derive the one-line purpose for a registry spec: prefer its hand-written
 * `catalogLine` (already a "name — purpose" line — we take the purpose after
 * the em dash), else fall back to the first sentence of its description.
 */
function purposeForSpec(spec: SharedToolSpec): string {
  const line = spec.catalogLine?.trim();
  if (line) {
    const dash = line.indexOf(" — ");
    if (dash >= 0) return line.slice(dash + 3).trim();
    return line;
  }
  const desc = (spec.description ?? "").replace(/\s+/g, " ").trim();
  const firstSentence = desc.split(/(?<=[.!?])\s/)[0];
  return firstSentence || desc || "(no description)";
}

/**
 * Build the flat list of every registered tool's inventory line: one per shared
 * registry spec (skipping `inAppOnly` specs, which are not registered on this
 * MCP host) PLUS every inline MCP-only tool. Pure and deterministic — the
 * registry drives it, so it can never drift from what index.ts registers.
 */
export function buildToolInventoryLines(
  specs: Record<string, SharedToolSpec> = SHARED_TOOL_SPECS,
  inline: ToolInventoryLine[] = INLINE_MCP_INVENTORY,
): ToolInventoryLine[] {
  const lines: ToolInventoryLine[] = [];
  for (const spec of Object.values(specs)) {
    if (spec.inAppOnly) continue; // not registered on the MCP host
    lines.push({ name: spec.mcpName, purpose: purposeForSpec(spec) });
  }
  for (const l of inline) lines.push({ ...l });
  return lines;
}

/**
 * Render the generated `<tool_inventory>` block: every tool name + purpose,
 * grouped by family (families in FAMILY_ORDER; tools within a family sorted by
 * name for stable output; unmapped tools fall into OTHER). Pure.
 */
export function buildToolInventory(
  specs: Record<string, SharedToolSpec> = SHARED_TOOL_SPECS,
  inline: ToolInventoryLine[] = INLINE_MCP_INVENTORY,
): string {
  const byFamily = new Map<Family, ToolInventoryLine[]>();
  for (const family of FAMILY_ORDER) byFamily.set(family, []);
  for (const line of buildToolInventoryLines(specs, inline)) {
    const family = TOOL_FAMILY[line.name] ?? "OTHER";
    byFamily.get(family)!.push(line);
  }
  const sections: string[] = [];
  for (const family of FAMILY_ORDER) {
    const items = byFamily.get(family)!;
    if (items.length === 0) continue;
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      sections.push(`  ${family}  ${item.name} — ${item.purpose}`);
    }
  }
  return ["<tool_inventory>", ...sections, "</tool_inventory>"].join("\n");
}

/**
 * The composed editing guide: the hand-written routing prose followed by the
 * generated, drift-proof tool inventory. Exported (and used by index.ts /
 * createDocmostMcpServer) as the MCP server's `instructions`.
 */
export const SERVER_INSTRUCTIONS =
  ROUTING_PROSE + "\n" + buildToolInventory();
