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
  "READ: find a page -> search (workspace-wide full-text); list -> listPages / listSpaces. Locate blocks and their ids CHEAPLY -> getOutline (compact top-level map; start here, not getPageJson). One block's subtree -> getNode (by attrs.id, or \"#<index>\" for tables, which carry no id). Find every occurrence of a string/regex ON a page (and where each is) -> searchInPage, NOT block-by-block getNode — it returns each hit's node ref + block index + context for a targeted comment. Whole page -> getPage (Markdown, lossy; inline <span data-comment-id> tags are comment anchors — markup, not text) or getPageJson (lossless ProseMirror with block ids). Hand a huge page (with images) to an external consumer without pulling it through the model context -> stashPage (returns a short-lived anonymous URL).\n" +
  "EDIT: fix wording/typos/numbers -> editPageText (find/replace inside blocks, no node id needed). Change ONE block (paragraph/heading/callout/etc.) structurally -> patchNode (by attrs.id from getOutline). Add a block -> insertNode (before/after a block by attrs.id or by anchor text, or append). Remove a block -> deleteNode (by attrs.id). Tables -> tableGet / tableUpdateCell / tableInsertRow / tableDeleteRow (address by \"#<index>\" from getOutline; table nodes have no attrs.id). Images -> insertImage (add from a web URL) / replaceImage (swap an existing image). Draw.io diagrams -> drawioCreate (create from mxGraph XML and insert), drawioGet (read a diagram as mxGraph XML + a hash), drawioUpdate (replace a diagram; pass the hash from drawioGet as baseHash for optimistic locking); before authoring a diagram, drawioShapes (look up verified stencil style-strings so a shape name never renders as an empty box) and drawioGuide (on-demand authoring reference: skeleton/layout/containers/icons-aws/icons-azure), and pass layout:\"elk\" to drawioCreate/drawioUpdate to auto-place nodes. Footnotes -> insertFootnote. Bulk/structural rewrite -> updatePageJson (full ProseMirror replace) or updatePageMarkdown (full plain-Markdown body replace, re-imported — block ids regenerate); prefer the granular tools above to avoid resending the whole ~100KB+ document. Complex/scripted rewrite (multiple coordinated edits, renumbering) -> docmostTransform: write a JS `(doc, ctx) => doc` transform, preview the diff with dryRun (default), then apply with dryRun:false; ctx.helpers includes commentsToFootnotes for turning inline comments into numbered footnotes.\n" +
  "PAGES: new -> createPage (Markdown). Rename (title only) -> renamePage. Move -> movePage. Delete -> deletePage (SOFT delete — the page goes to trash and is restorable; nothing is permanent). Copy/replace a page's whole content from another page (server-side, no document through the model) -> copyPageContent. Sharing -> sharePage / unsharePage / listShares; sharePage makes the page PUBLICLY accessible — do it only when explicitly asked.\n" +
  "COMMENTS: createComment is always inline and requires an EXACT selection — contiguous text from a single block, <=250 chars (fails rather than leaving an unanchored comment); reply to a thread via parentCommentId. Propose a concrete text fix for one-click human approval -> createComment with suggestedText (the exact plain-text replacement for the selection; the selection must then be UNIQUE in the page — extend it with context if needed); prefer this over editing directly when the change is subjective or needs the author's sign-off. Manage -> listComments, updateComment, resolveComment (resolve/reopen, reversible — prefer over delete to close), deleteComment, checkNewComments.\n" +
  "HISTORY: review what changed -> diffPageVersions (a historyId vs current, or two versions). List saved versions -> listPageHistory. Undo a bad edit -> restorePageVersion (writes a past version back as current; itself revertible). Export a page to self-contained Docmost Markdown (with comment anchors) -> exportPageMarkdown.";

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
  listPages: "READ",
  listSpaces: "READ",
  getOutline: "READ",
  getNode: "READ",
  searchInPage: "READ",
  getPage: "READ",
  getPageJson: "READ",
  getWorkspace: "READ",
  stashPage: "READ",
  // EDIT
  editPageText: "EDIT",
  patchNode: "EDIT",
  insertNode: "EDIT",
  deleteNode: "EDIT",
  updatePageJson: "EDIT",
  updatePageMarkdown: "EDIT",
  tableGet: "EDIT",
  tableUpdateCell: "EDIT",
  tableInsertRow: "EDIT",
  tableDeleteRow: "EDIT",
  insertImage: "EDIT",
  replaceImage: "EDIT",
  insertFootnote: "EDIT",
  drawioGet: "EDIT",
  drawioCreate: "EDIT",
  drawioUpdate: "EDIT",
  drawioShapes: "EDIT",
  drawioGuide: "EDIT",
  docmostTransform: "EDIT",
  // PAGES
  createPage: "PAGES",
  renamePage: "PAGES",
  movePage: "PAGES",
  deletePage: "PAGES",
  copyPageContent: "PAGES",
  sharePage: "PAGES",
  unsharePage: "PAGES",
  listShares: "PAGES",
  // COMMENTS
  createComment: "COMMENTS",
  listComments: "COMMENTS",
  updateComment: "COMMENTS",
  resolveComment: "COMMENTS",
  deleteComment: "COMMENTS",
  checkNewComments: "COMMENTS",
  // HISTORY
  diffPageVersions: "HISTORY",
  listPageHistory: "HISTORY",
  restorePageVersion: "HISTORY",
  exportPageMarkdown: "HISTORY",
  // importPageMarkdown is now inAppOnly (#411) — it is not registered on the
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
    name: "tableGet",
    purpose:
      "read a table as a matrix of cell texts + per-cell paragraph ids.",
  },
  {
    name: "search",
    purpose:
      "full-text search for pages and content across the whole workspace.",
  },
  {
    name: "docmostTransform",
    purpose:
      "edit a page by running a sandboxed JS `(doc, ctx) => doc` transform, with a dryRun diff preview.",
  },
  {
    name: "updateComment",
    purpose: "update an existing comment's content (creator only).",
  },
  {
    name: "deleteComment",
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
