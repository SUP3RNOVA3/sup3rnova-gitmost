// Zod-agnostic shared tool-spec registry consumed by BOTH the zod-v3 MCP server
// (packages/mcp/src/index.ts) and the zod-v4 in-app AI-SDK service
// (apps/server/src/core/ai-chat/tools/ai-chat-tools.service.ts). Intentionally
// imports NO zod: each consumer passes its OWN zod namespace into buildShape,
// because the two packages are on different zod majors (v3 here, v4 in the
// server) and a zod schema object built with one major cannot be reused by the
// other. The builders below only touch z.string()/.min()/.optional()/.describe(),
// z.array() and z.object() — API identical across v3 and v4 — so a single
// builder works with either namespace.
//
// Only tools whose snake_case/camelCase name, input schema AND model-facing
// description are genuinely identical across both layers live here. Tools that
// diverge on purpose (security guardrails, tuned UX, "Reversible" framing on
// some write tools, different limits, hybrid-RRF search, etc.) stay defined
// per-layer and are NOT represented here.
//
// SERVER_INSTRUCTIONS note (issue #448): the intent-routing guide MCP clients
// receive on initialize is now SPLIT — its tool INVENTORY is GENERATED from this
// registry (mcpName + catalogLine) by server-instructions.ts, so adding /
// renaming / removing a spec here updates the guide's inventory AUTOMATICALLY;
// no prose edit is needed. Only an INLINE MCP-only tool (registerTool in
// index.ts, not a spec here) needs a hand-written line in INLINE_MCP_INVENTORY —
// enforced by test/unit/tool-inventory.test.mjs. The routing PROSE (the "when to
// use what" hints) in server-instructions.ts stays manual, but it is no longer a
// drift-guard for the tool set.

// Loose on purpose — see the comment above. The two zod majors expose different
// static type surfaces, so typing this precisely would couple the registry to
// one of them. Each builder uses only the common, stable subset of the API.
type ZodLike = any;

// The `node` normalizer shared by BOTH hosts (patch_node / insert_node /
// update_page_json): the model sometimes serializes a ProseMirror node arg as a
// JSON string, so we parse a string to an object (throwing a documented message
// on invalid JSON) and pass an object through. It lives in the converter package
// (#414) so it is the ONE copy both the MCP server and the in-app server import;
// putting it in a shared execute here keeps that single normalization in one
// place instead of hand-mirrored per host. Pure — safe across the zod boundary.
import { parseNodeArg } from '@docmost/prosemirror-markdown';
// PURE draw.io helpers (issue #424): drawio_shapes / drawio_guide are NOT client
// methods — they read a bundled shape catalog / authoring guide with no network.
// Imported here (same-package runtime import, precedent: parseNodeArg above) so
// their canonical `execute` lives in the registry like every other shared tool
// and BOTH hosts wire them through the loop — no per-host inline duplication.
import { searchShapes } from './lib/drawio-shapes.js';
import { getGuideSection } from './lib/drawio-guide.js';
// Type-only import (erased at compile) of the real client so `DocmostClientLike`
// is DERIVED from it (issue #446), not hand-mirrored. The loosest correct client
// surface both hosts satisfy: the in-app host passes its own DERIVED
// `DocmostClientLike` (a Pick of the same class) and the MCP host passes the real
// `DocmostClient`, so both are structurally assignable to this shared alias.
import type { DocmostClient } from './client.js';

/**
 * The client surface a shared `execute` may call — the LOOSEST correct type both
 * hosts satisfy: a `Pick` of the real `DocmostClient` methods the executes below
 * use. DERIVED from the real class (issue #446) so a signature change to any
 * consumed method surfaces as a compile error in the execute bodies here, not a
 * silent runtime "wrong argument". Kept as a Pick (not the whole class) so the
 * standalone MCP host's full `DocmostClient` AND the in-app host's OWN narrower
 * `DocmostClientLike` (also a Pick of the same class, a superset of these methods)
 * are both structurally assignable to it. `import type` is fully erased, so
 * tool-specs.ts pulls in no runtime dependency on the client and still crosses the
 * zod-major boundary freely. When you add a client call to an execute below, add
 * its method name here too (a compile error will point you at it).
 */
export type DocmostClientLike = Pick<
  DocmostClient,
  | 'getWorkspace'
  | 'getSpaces'
  | 'listShares'
  | 'listPages'
  | 'getPage'
  | 'getPageJson'
  | 'getOutline'
  | 'getNode'
  | 'searchInPage'
  | 'listComments'
  | 'checkNewComments'
  | 'listPageHistory'
  | 'diffPageVersions'
  | 'exportPageMarkdown'
  | 'createPage'
  | 'renamePage'
  | 'movePage'
  | 'deletePage'
  | 'editPageText'
  | 'patchNode'
  | 'insertNode'
  | 'deleteNode'
  | 'updatePageJson'
  | 'tableInsertRow'
  | 'tableDeleteRow'
  | 'tableUpdateCell'
  | 'copyPageContent'
  | 'importPageMarkdown'
  | 'sharePage'
  | 'unsharePage'
  | 'restorePageVersion'
  | 'stashPage'
  | 'insertFootnote'
  | 'insertImage'
  | 'replaceImage'
  | 'drawioGet'
  | 'drawioCreate'
  | 'drawioUpdate'
  | 'createComment'
  | 'resolveComment'
>;

/**
 * A shared tool `execute`: the single canonical mapping from validated schema
 * args to the client call. Plain JS — it crosses the zod-major boundary (v3 in
 * the MCP package, v4 on the server) freely, receiving the already-validated,
 * type-erased args from whichever host invoked it. It returns RAW data; the host
 * applies its own result envelope (the MCP transport wraps it as JSON text
 * content, the in-app AI-SDK host returns it as-is). Host-specific overrides
 * (`mcpExecute`/`inAppExecute`) return a value the host uses instead of wrapping.
 */
export type SharedToolExecute = (
  client: DocmostClientLike,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface SharedToolSpec {
  /** snake_case tool name passed to McpServer.registerTool. */
  mcpName: string;
  /** camelCase key in the ai-SDK tools object (the in-app layer). */
  inAppKey: string;
  /** Single canonical model-facing description used by both layers. */
  description: string;
  /**
   * Deferred-tool tier for the IN-APP agent (#332). 'core' tools are always
   * active; 'deferred' tools are hidden behind the <tool_catalog> and loaded on
   * demand via the loadTools meta-tool. This is an IN-APP concern only: the
   * standalone /mcp server ignores this field and registers every tool normally
   * (registerShared in index.ts reads mcpName/description/buildShape only).
   */
  tier: 'core' | 'deferred';
  /**
   * Hand-written one-liner "name — purpose" shown in the in-app agent's
   * <tool_catalog> for a DEFERRED tool (#332). Deliberately NOT derived from the
   * description's first sentence — a concise, accurate purpose line. Present on
   * every spec (core tools too) for uniformity; only deferred ones are rendered.
   * Inert for the external /mcp server.
   */
  catalogLine: string;
  /**
   * Builds the tool's input schema as a plain object of zod fields (a
   * ZodRawShape). Called with the consumer's own zod namespace. Omitted for
   * no-argument tools (the MCP side then registers with no inputSchema and the
   * in-app side uses z.object({})).
   */
  buildShape?: (z: ZodLike) => Record<string, unknown>;
  /**
   * Single canonical mapping from validated schema args to the client call,
   * shared by BOTH hosts. Returns RAW data — the MCP host wraps it as JSON text
   * content (jsonContent), the in-app host returns it as-is. Present on tools
   * whose mapping AND raw result are identical across the two layers. When a host
   * needs a genuinely different mapping or result shape, it supplies an override
   * (below) and the host uses that INSTEAD of `execute`.
   */
  execute?: SharedToolExecute;
  /**
   * MCP-host override for a DELIBERATE per-layer difference (a guardrail, an
   * omitted param, or a non-JSON result envelope like a resource_link / a bare
   * success line). When present, the MCP host calls this and uses its return
   * value VERBATIM (it is NOT re-wrapped in jsonContent), so this override owns
   * the full MCP content envelope.
   */
  mcpExecute?: SharedToolExecute;
  /**
   * In-app-host override for a DELIBERATE per-layer difference (a projected
   * result shape, a different guardrail message). When present, the in-app host
   * calls this and returns its value as the tool result (no wrapping).
   */
  inAppExecute?: SharedToolExecute;
  /** Registered only on the MCP host (skipped by the in-app registry loop). */
  mcpOnly?: boolean;
  /** Registered only on the in-app host (skipped by the MCP registry loop). */
  inAppOnly?: boolean;
}

// --- Shared execute helpers -------------------------------------------------
//
// Each helper is the ONE canonical arg->client mapping for a tool (or a host
// override where the two layers deliberately differ). They are attached to their
// spec below. Kept as named functions (not inline) so the spec table stays
// readable and each mapping is individually greppable/testable.
//
// The `args` are the host's already-validated, zod-erased input; we read the
// same fields the tool's buildShape declares. Return RAW data unless the name is
// an mcp*/inApp* override that owns the host's full result shape.

/** Format a JSON payload as the MCP transport's text-content envelope. Mirrors
 *  the private `jsonContent` in index.ts so an mcpExecute override that must NOT
 *  be re-wrapped can still emit the standard envelope for the data part. */
const mcpJson = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Compact HARD-RULES block injected into the drawio_create / drawio_update
 * descriptions (issue #424 — the jgraph/drawio-mcp pattern of putting the
 * must-follow rules right where the model reads them at call time). Deliberately
 * terse; the long-form authoring guidance lives in drawio_guide.
 */
export const DRAWIO_HARD_RULES =
  ' RULES: id="0" and id="1"(parent="0") sentinels are MANDATORY; each cell is ' +
  'vertex="1" XOR edge="1" (a container/group is neither); every edge carries a ' +
  'child <mxGeometry relative="1" as="geometry"/>; ids are unique; NO XML ' +
  'comments; put html=1 in styles and XML-escape value (& -> &amp;, < -> &lt;); a ' +
  "newline in a label is &#xa;, never a literal \\n; containers are TRANSPARENT " +
  "(fillColor=none;container=1;dropTarget=1;) with children set parent=<groupId> " +
  'and RELATIVE coords, and an edge between different containers is parent="1"; set ' +
  'adaptiveColors="auto" on <mxGraphModel> (free dark-theme adaptation for ' +
  'strokeColor/fillColor/fontColor="default"); do NOT guess shape=mxgraph.* names ' +
  "(a wrong name renders as an empty box) — call drawio_shapes first; call " +
  "drawio_guide(section) for authoring help. Pass layout:\"elk\" to let the server " +
  "compute coordinates from your rough placement. The result carries geometry " +
  "WARNINGS (overlaps, an edge through a shape, edge-on-edge, gaps <150px, a label " +
  "wider than its shape, negative coords) — they do NOT block the write; fix them " +
  "and retry, max 2 iterations.";

export const SHARED_TOOL_SPECS = {
  // --- no-argument read tools ---

  getWorkspace: {
    mcpName: 'get_workspace',
    inAppKey: 'getWorkspace',
    description: 'Fetch metadata about the current workspace (name, settings).',
    tier: 'core',
    catalogLine: 'getWorkspace — fetch current workspace metadata (name, settings).',
    execute: (client) => client.getWorkspace(),
  },

  listSpaces: {
    mcpName: 'list_spaces',
    inAppKey: 'listSpaces',
    description:
      'List the spaces the current user can access. Returns the array of ' +
      'spaces (id, name, slug, ...).',
    tier: 'core',
    catalogLine: 'listSpaces — list the spaces the user can access (id, name, slug).',
    execute: (client) => client.getSpaces(),
  },

  listShares: {
    mcpName: 'list_shares',
    inAppKey: 'listShares',
    description:
      'List all public shares in the workspace with page titles and public URLs.',
    tier: 'deferred',
    catalogLine: 'listShares — list all public shares in the workspace with their URLs.',
    execute: (client) => client.listShares(),
  },

  // --- single-pageId read tools ---

  getPageJson: {
    mcpName: 'get_page_json',
    inAppKey: 'getPageJson',
    description:
      'Get page details with the raw ProseMirror JSON content (lossless: ' +
      'includes block ids, callouts, tables, link/image attributes) plus the ' +
      'slugId used in URLs. Use the block ids it returns to make precise ' +
      'structural edits or surgical text edits without resending the page.',
    tier: 'deferred',
    catalogLine:
      "getPageJson — get a page's raw ProseMirror JSON (lossless, with block ids).",
    buildShape: (z) => ({
      pageId: z.string().min(1),
    }),
    execute: (client, { pageId }) => client.getPageJson(pageId as string),
  },

  getOutline: {
    mcpName: 'get_outline',
    inAppKey: 'getOutline',
    description:
      "Return a COMPACT outline of a page's top-level blocks ({index, type, " +
      'id, level, firstText}; tables add rows/cols/header; lists add item ' +
      'count) WITHOUT the full document body. Use it to locate sections/tables ' +
      'and grab block ids cheaply before fetching, patching or inserting ' +
      'individual blocks.',
    tier: 'core',
    catalogLine:
      "getOutline — compact outline of a page's top-level blocks with their ids.",
    buildShape: (z) => ({
      pageId: z.string().min(1),
    }),
    execute: (client, { pageId }) => client.getOutline(pageId as string),
  },

  // --- two-id read tool ---

  getNode: {
    mcpName: 'get_node',
    inAppKey: 'getNode',
    description:
      "Fetch a single node's full ProseMirror subtree (lossless) without " +
      'pulling the whole document. `nodeId` is a block id from the page ' +
      'outline or page-JSON view (works for headings/paragraphs/callouts/images), OR ' +
      '`#<index>` to fetch a top-level block by its outline index — use the ' +
      '`#<index>` form for tables/rows/cells, which carry no id.',
    tier: 'core',
    catalogLine:
      "getNode — fetch one block's ProseMirror subtree by block id or #index.",
    buildShape: (z) => ({
      pageId: z.string().min(1),
      nodeId: z.string().min(1),
    }),
    execute: (client, { pageId, nodeId }) =>
      client.getNode(pageId as string, nodeId as string),
  },

  // --- in-page occurrence search (client-side, over ProseMirror plain text) ---

  searchInPage: {
    mcpName: 'search_in_page',
    inAppKey: 'searchInPage',
    description:
      'Find every occurrence of a string (or regex) INSIDE one page and get ' +
      'WHERE each is — instead of pulling blocks one-by-one with get_node. ' +
      'Searches the plain text of each text block/cell (marks glued, so a match ' +
      'survives bold/italic/link splits; comment anchors do not interfere). ' +
      'Returns { total, truncated, matches:[{ nodeId, blockIndex, type, before, ' +
      'match, after }] }: `nodeId` is the block id (or "#<index>" for ' +
      'table/cell content) — pass it to get_node/patch_node (the "#<index>" ' +
      'form resolves with get_node but NOT patch_node, which only accepts a real ' +
      'block id). To anchor a comment, do NOT pass nodeId to create_comment (it ' +
      'has no nodeId param); build a UNIQUE text selection from before+match+' +
      'after and pass it as create_comment\'s `selection`. `blockIndex` is the ' +
      'get_outline index; `before`/`after` give ~40 chars of context to build ' +
      'that unique selection. `total` counts all ' +
      'hits and `truncated` is true when more than `limit` were found (nothing ' +
      'is silently dropped). Default is a literal, case-INSENSITIVE substring; ' +
      'set regex:true for an RE2 regular expression (linear-time, ReDoS-safe: ' +
      'char classes, word boundaries, anchors and quantifiers work; lookaround ' +
      '(?=…)/(?<=…) and backreferences \\1 are NOT supported) and ' +
      'caseSensitive:true to match case. Ideal for systematic ' +
      'editorial sweeps (unquoted "ё", straight quotes, "т.е.", stray units). An ' +
      'invalid regex or an empty query returns a clear error to fix.',
    tier: 'core',
    catalogLine:
      'searchInPage — find every occurrence of a string/regex inside one page, with locations.',
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('ID of the page to search'),
      query: z
        .string()
        .min(1)
        .describe('The text to find (a literal substring, or a regex when regex:true)'),
      regex: z
        .boolean()
        .optional()
        .describe(
          'Treat query as an RE2 regular expression — linear-time, ReDoS-safe; ' +
            'no lookaround or backreferences (default false).',
        ),
      caseSensitive: z
        .boolean()
        .optional()
        .describe('Case-sensitive matching (default false).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Max matches to RETURN (default 50, max 200); total is always reported.'),
    }),
    execute: (client, { pageId, query, regex, caseSensitive, limit }) =>
      client.searchInPage(pageId as string, query as string, {
        regex: regex as boolean | undefined,
        caseSensitive: caseSensitive as boolean | undefined,
        limit: limit as number | undefined,
      }),
  },

  // --- node delete ---

  deleteNode: {
    mcpName: 'delete_node',
    inAppKey: 'deleteNode',
    description:
      'Remove a single block by its attrs.id (from the page outline or ' +
      'page-JSON view) WITHOUT resending the whole document.',
    tier: 'deferred',
    catalogLine: 'deleteNode — remove a single content block by its block id.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      nodeId: z.string().min(1),
    }),
    execute: (client, { pageId, nodeId }) =>
      client.deleteNode(pageId as string, nodeId as string),
  },

  // --- single-block structural write (patch / insert) ---
  //
  // CANONICAL description merges both layers: the MCP copy's "WITHOUT resending
  // the whole document" + "cheaper/safer than a full-document replace" guidance
  // AND the in-app copy's "keeps the same node id" + "Reversible via page
  // history" framing — nothing either side conveyed is dropped. Sibling tools are
  // named in transport-neutral prose ("the page-JSON view", "a full-document
  // replace") to match the rest of the registry, since the two layers expose
  // those siblings under different (snake_case vs camelCase) identifiers.
  patchNode: {
    mcpName: 'patch_node',
    inAppKey: 'patchNode',
    description:
      'Replace a single content block identified by its attrs.id with a new ' +
      'ProseMirror node, WITHOUT resending the whole document; the replacement ' +
      'keeps the same node id. Get the block id from the page outline (cheap) ' +
      'or the page-JSON view, then ' +
      'pass a ProseMirror node to put in its place. Example node: a paragraph ' +
      '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]} or a ' +
      'heading {"type":"heading","attrs":{"level":2},"content":' +
      '[{"type":"text","text":"Title"}]}. Bold is a mark: ' +
      '{"type":"text","text":"x","marks":[{"type":"bold"}]}. The node may be a ' +
      'JSON object or a JSON string (both accepted). EVERY node, including ' +
      'nested children, must carry a string `type` from the Docmost schema; ' +
      'text leaves are {"type":"text","text":"..."} (a bare {"text":"..."} is ' +
      'rejected up front). Cheaper and safer than ' +
      'replacing the whole document for one-block structural edits. Reversible: ' +
      'the previous version is kept in page history.',
    tier: 'deferred',
    catalogLine:
      'patchNode — replace one block with a new ProseMirror node, keeping its id.',
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('ID of the page containing the block'),
      nodeId: z
        .string()
        .min(1)
        .describe(
          'attrs.id of the block to replace (from the page outline or ' +
            'page-JSON view)',
        ),
      node: z
        .any()
        .describe(
          'ProseMirror node to put in place of the node with this id, e.g. ' +
            '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}. ' +
            'JSON object or JSON string both accepted.',
        ),
    }),
    // parseNodeArg normalizes a JSON-string node into an object (the model
    // sometimes serializes it as a string) before the client's typeof-object
    // guard rejects it — identical on both hosts.
    execute: (client, { pageId, nodeId, node }) =>
      client.patchNode(pageId as string, nodeId as string, parseNodeArg(node)),
  },

  insertNode: {
    mcpName: 'insert_node',
    inAppKey: 'insertNode',
    description:
      'Insert a block before/after another block (by attrs.id or anchor text) ' +
      'or append it at the end (top level). For before/after you MUST provide ' +
      'EXACTLY ONE of anchorNodeId or anchorText. Get anchor block ids from the ' +
      'page outline or the page-JSON view. Avoids resending the whole document. ' +
      'Can also insert ' +
      'table structure: to add a tableRow, pass a tableRow node with position ' +
      'before/after and anchor INSIDE the target table — anchorNodeId of any ' +
      'block/cell in it, or anchorText matching the table; to add a ' +
      'tableCell/tableHeader, use anchorNodeId of a block inside the target row ' +
      '(anchorText only resolves top-level blocks, so it cannot target a row). ' +
      "`anchorText` is matched against the block's literal rendered plain text " +
      '(no markdown); markdown/emoji are tolerated as a fallback; prefer plain ' +
      'text or anchorNodeId. Note: append is top-level only and rejects ' +
      'structural table nodes. Example node: a paragraph ' +
      '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]} or a ' +
      'heading {"type":"heading","attrs":{"level":2},"content":' +
      '[{"type":"text","text":"Title"}]}. Bold is a mark: ' +
      '{"type":"text","text":"x","marks":[{"type":"bold"}]}. EVERY node, ' +
      'including nested children, must carry a string `type` from the Docmost ' +
      'schema; text leaves are {"type":"text","text":"..."} (a bare ' +
      '{"text":"..."} is rejected up front). The node may be a ' +
      'JSON object or a JSON string (both accepted). Reversible via page history.',
    tier: 'deferred',
    catalogLine:
      'insertNode — insert a block before/after an anchor, or append at the end.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      node: z
        .any()
        .describe(
          'ProseMirror node to insert, e.g. ' +
            '{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}. ' +
            'JSON object or JSON string both accepted.',
        ),
      position: z
        .enum(['before', 'after', 'append'])
        .describe('Where to insert relative to the anchor.'),
      anchorNodeId: z
        .string()
        .optional()
        .describe('Anchor block id (for before/after).'),
      anchorText: z
        .string()
        .optional()
        .describe(
          "Anchor text fragment (for before/after), matched against the " +
            "block's literal rendered plain text (no markdown). Markdown/emoji " +
            'are tolerated as a fallback; prefer plain text or anchorNodeId.',
        ),
    }),
    execute: (client, { pageId, node, position, anchorNodeId, anchorText }) =>
      client.insertNode(pageId as string, parseNodeArg(node), {
        position: position as 'before' | 'after' | 'append',
        anchorNodeId: anchorNodeId as string | undefined,
        anchorText: anchorText as string | undefined,
      }),
  },

  // --- share management ---

  // Unified from the per-layer inline definitions (#294). Both layers already
  // carried the "only share when explicitly asked" security framing (the
  // "per-transport divergence" note on the old inline copies was stale), so
  // there was no real behavioral divergence to preserve — only wording drift.
  sharePage: {
    mcpName: 'share_page',
    inAppKey: 'sharePage',
    // CANONICAL: merges the MCP copy's URL-format + idempotency detail with the
    // in-app copy's reversibility note; keeps the security framing both had.
    description:
      'Make a page PUBLICLY accessible (idempotent) and return its public URL ' +
      '(format: <app>/share/<key>/p/<slugId>). This exposes the page content ' +
      'to ANYONE with the URL — only share when the user explicitly asked. ' +
      'Reversible: unshare it later to revoke the public URL.',
    tier: 'deferred',
    catalogLine: 'sharePage — make a page publicly accessible and return its URL.',
    // Reconciled: MCP's stricter .min(1) on pageId kept; field descriptions from
    // the in-app copy. The MCP execute keeps its own `searchIndexing ?? true`
    // default (a per-layer concern, not part of the shared schema).
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page to share.'),
      searchIndexing: z
        .boolean()
        .optional()
        .describe('Allow public search engines to index it (default true).'),
    }),
    // `searchIndexing ?? true` is a no-op default: the client method already
    // defaults searchIndexing to true, so passing `undefined` (the in-app form)
    // and `?? true` (the old MCP form) are byte-identical — one canonical mapping.
    execute: (client, { pageId, searchIndexing }) =>
      client.sharePage(pageId as string, (searchIndexing as boolean | undefined) ?? true),
  },

  unsharePage: {
    mcpName: 'unshare_page',
    inAppKey: 'unsharePage',
    description: 'Remove the public share of a page (revokes the public URL).',
    tier: 'deferred',
    catalogLine: "unsharePage — revoke a page's public share (removes the public URL).",
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('ID of the page to unshare'),
    }),
    execute: (client, { pageId }) => client.unsharePage(pageId as string),
  },

  // --- version history ---

  diffPageVersions: {
    mcpName: 'diff_page_versions',
    inAppKey: 'diffPageVersions',
    description:
      'Diff two versions of a page and return a Docmost-equivalent change set ' +
      '(inserted/deleted text, integrity counts for images/links/tables/' +
      'callouts/footnote markers, and a human-readable markdown summary). ' +
      "`from`/`to` each accept a historyId, or null/'current' for the page's " +
      'current content (defaults: from=current, to=current — pass a historyId ' +
      'from the page-history list to compare against the live page).',
    tier: 'deferred',
    catalogLine:
      'diffPageVersions — diff two page versions and return the change set + summary.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      from: z
        .string()
        .optional()
        .describe("historyId, or 'current'/omit for current content"),
      to: z
        .string()
        .optional()
        .describe("historyId, or 'current'/omit for current content"),
    }),
    execute: (client, { pageId, from, to }) =>
      client.diffPageVersions(
        pageId as string,
        from as string | undefined,
        to as string | undefined,
      ),
  },

  listPageHistory: {
    mcpName: 'list_page_history',
    inAppKey: 'listPageHistory',
    description:
      "List a page's saved versions (Docmost auto-snapshots on every save), " +
      'newest first, cursor-paginated. Returns { items, nextCursor }; each ' +
      "item's id is the historyId to pass to the page diff or restore tools.",
    tier: 'deferred',
    catalogLine:
      "listPageHistory — list a page's saved versions (newest first, paginated).",
    buildShape: (z) => ({
      pageId: z.string().min(1),
      cursor: z
        .string()
        .optional()
        .describe('Pagination cursor from a previous nextCursor'),
    }),
    execute: (client, { pageId, cursor }) =>
      client.listPageHistory(pageId as string, cursor as string | undefined),
  },

  restorePageVersion: {
    mcpName: 'restore_page_version',
    inAppKey: 'restorePageVersion',
    description:
      'Restore a page to a saved version: writes that version\'s content back ' +
      'as the page\'s current content (Docmost has no restore endpoint, so ' +
      'this creates a NEW history snapshot — the restore is itself revertible). ' +
      'Get the historyId from the page-history list.',
    tier: 'deferred',
    catalogLine:
      'restorePageVersion — restore a page to a saved history version (revertible).',
    buildShape: (z) => ({
      historyId: z.string().min(1),
    }),
    execute: (client, { historyId }) =>
      client.restorePageVersion(historyId as string),
  },

  // --- markdown round-trip ---

  importPageMarkdown: {
    mcpName: 'import_page_markdown',
    inAppKey: 'importPageMarkdown',
    description:
      "Replace a page's content from a self-contained Docmost-flavoured " +
      'Markdown file produced by the page-Markdown export tool. Restores comment ' +
      'highlight anchors and diagrams from their inline HTML. NOTE: comment ' +
      'thread records are NOT created/updated/deleted on the server by this ' +
      'tool — only the page body + inline comment marks are written; manage ' +
      'comment threads via the comment tools/UI.',
    tier: 'deferred',
    catalogLine:
      "importPageMarkdown — replace a page's content from exported Docmost Markdown.",
    buildShape: (z) => ({
      pageId: z.string().min(1),
      markdown: z.string().min(1),
    }),
    execute: (client, { pageId, markdown }) =>
      client.importPageMarkdown(pageId as string, markdown as string),
  },

  // --- server-side content copy ---

  copyPageContent: {
    mcpName: 'copy_page_content',
    inAppKey: 'copyPageContent',
    description:
      "Replace targetPageId's content with a copy of sourcePageId's content, " +
      'entirely server-side — the document is NOT sent through the model. The ' +
      'target keeps its own title and slug; only its body is replaced. Ideal ' +
      "for 'make page A's content equal to B' or 'replace A with B but keep A's URL'.",
    tier: 'deferred',
    catalogLine:
      "copyPageContent — replace one page's body with a copy of another page's body.",
    buildShape: (z) => ({
      sourcePageId: z.string().min(1).describe('Page to copy content FROM'),
      targetPageId: z
        .string()
        .min(1)
        .describe('Page whose content is REPLACED (title/slug kept)'),
    }),
    execute: (client, { sourcePageId, targetPageId }) =>
      client.copyPageContent(sourcePageId as string, targetPageId as string),
  },

  // --- surgical text edit (folds in the documented drift-bug fix) ---
  //
  // CANONICAL description is the CORRECTED in-app wording: a formatting-only
  // change is REFUSED into failed[] (not silently stripped-and-retried). The
  // stale MCP claim that "Markdown wrappers are tolerated via a strip-and-retry
  // fallback" is intentionally absent here.
  editPageText: {
    mcpName: 'edit_page_text',
    inAppKey: 'editPageText',
    description:
      "Surgical find/replace inside a page's text, preserving all block " +
      'ids and marks. A find MAY cross bold/italic/link boundaries; the ' +
      'replacement inherits marks from the unchanged common prefix/suffix ' +
      '(so editing plain text next to a bold word keeps it bold, and ' +
      'editing inside a bold word keeps the new text bold). Each find must ' +
      'match exactly once unless replaceAll is set. The batch applies what ' +
      'it can and returns applied[] + failed[] plus a verify change-report ' +
      '(the text/marks/structure that ACTUALLY changed — read it to confirm ' +
      'your edit landed; do not assume success); a fully-unmatched batch ' +
      'writes nothing and errors. find and replace are LITERAL text, not ' +
      'markdown. This tool edits plain text ONLY and CANNOT add or remove ' +
      'formatting marks: a formatting change — find/replace that differ only ' +
      'in markdown markers (e.g. find:"~~x~~", replace:"x"), or a replace ' +
      'containing **bold**/~~strike~~/`code` wrappers — is REFUSED into ' +
      'failed[]. To change bold/italic/strike/code/link, read the block as ' +
      'page JSON and use a structural node patch/update to set its marks. ' +
      'Examples: edits:[{find:"teh",replace:"the"}]; edits:[{find:"Hello ' +
      'world",replace:"Hello there"}] (crosses a bold boundary).',
    tier: 'core',
    catalogLine:
      "editPageText — surgical find/replace of plain text in a page, preserving ids/marks.",
    buildShape: (z) => ({
      pageId: z.string().describe('ID of the page to edit'),
      edits: z
        .array(
          z.object({
            find: z.string().describe('Exact text to find'),
            replace: z.string().describe('Replacement text (may be empty)'),
            replaceAll: z
              .boolean()
              .optional()
              .describe('Replace every occurrence (default: must match once)'),
          }),
        )
        .min(1)
        .describe('List of find/replace operations, applied in order'),
    }),
    execute: (client, { pageId, edits }) =>
      client.editPageText(
        pageId as string,
        edits as Parameters<DocmostClientLike['editPageText']>[1],
      ),
  },

  // --- hand a large page to an external consumer without bloating context ---
  stashPage: {
    mcpName: 'stash_page',
    inAppKey: 'stashPage',
    description:
      'Serialize a whole page (the full ProseMirror JSON, as get_page_json ' +
      'returns) into an ephemeral in-memory blob and return ONLY a short ' +
      'anonymous URL to it — the body NEVER enters the model context, so this ' +
      'is the way to hand a large page (or its images) to an external consumer ' +
      'without truncation. Every internal file/image attachment is mirrored ' +
      'into the same sandbox and its src rewritten to a sandbox URL, so the ' +
      'consumer can fetch the images anonymously too; external http(s) images ' +
      'are left untouched. Returns { uri, size, sha256, images:{mirrored, ' +
      'failed} }. Integrity: the blob is served with ETag = its sha256, so a ' +
      'truncated/corrupted fetch is detectable. Blobs are RAM-only: they expire ' +
      'after a short TTL (~1h) and are cleared on restart — consume the URL ' +
      'within the TTL and one uptime, or re-stash. A blob is bound to the ' +
      'server instance that created it: in a multi-replica deployment without ' +
      'sticky sessions a blob stored on one instance is not retrievable via the ' +
      'sandbox URL on another (it 404s like an expired one).',
    tier: 'deferred',
    catalogLine:
      'stashPage — serialize a whole page to a short anonymous URL without loading its body.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
    }),
    // In-app returns the full documented `{ uri, size, sha256, images }` object
    // as-is (the canonical execute).
    execute: (client, { pageId }) => client.stashPage(pageId as string),
    // The MCP transport must deliver the body as a resource_link (so it never
    // enters the model context) PLUS a structuredContent mirror of the documented
    // shape (sha256 = the blob's ETag, mirror counts). Owns its full envelope, so
    // it is NOT wrapped in jsonContent.
    mcpExecute: async (client, { pageId }) => {
      const result = await client.stashPage(pageId as string);
      return {
        content: [
          {
            type: 'resource_link' as const,
            uri: result.uri,
            name: 'page.json',
            mimeType: 'application/json',
            size: result.size,
          },
        ],
        structuredContent: {
          uri: result.uri,
          sha256: result.sha256,
          size: result.size,
          images: result.images,
        },
      };
    },
  },

  // --- page tools (unified from the per-layer inline definitions, #294) ---
  //
  // Descriptions merge both layers (the MCP copy's richer structural notes + the
  // in-app copy's "Reversible via history/trash" framing where it added one).
  // Field constraints keep the MCP copy's stricter .min(1) EXCEPT where the
  // in-app layer deliberately allowed a looser value (documented per field).

  getPage: {
    mcpName: 'get_page',
    inAppKey: 'getPage',
    description:
      'Fetch a single page as Markdown by its id. Returns the page title and ' +
      'its Markdown content. The Markdown conversion is LOSSY (block ids, exact ' +
      'table/callout structure are approximated); for a lossless representation ' +
      'use the lossless page-JSON read tool. Inline <span data-comment-id> tags in the markdown ' +
      'are comment highlight anchors (also present for RESOLVED threads) — ' +
      'treat them as markup, not page text.',
    tier: 'core',
    catalogLine: 'getPage — fetch a page as Markdown by its id.',
    // Reconciled: MCP's stricter .min(1) kept; in-app's more-informative
    // "(or slugId)" describe kept.
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id (or slugId) of the page.'),
    }),
    // MCP wraps the raw `{ data, success }` as JSON. The in-app host instead
    // projects a token-efficient `{ title, markdown }` (its long-standing shape).
    execute: (client, { pageId }) => client.getPage(pageId as string),
    inAppExecute: async (client, { pageId }) => {
      // getPage(pageId) -> { data: filterPage(page, markdown), success }.
      const result = (await client.getPage(pageId as string)) as {
        data?: { title?: string; content?: string };
      };
      const data = result?.data ?? {};
      return {
        title: data.title ?? '',
        markdown: typeof data.content === 'string' ? data.content : '',
      };
    },
  },

  listPages: {
    mcpName: 'list_pages',
    inAppKey: 'listPages',
    description:
      'List the most recent pages (ordered by updatedAt, descending), ' +
      'optionally scoped to a single space. Returns a bounded list (default ' +
      '50, max 100) — use search for lookups in large spaces. Pass tree:true ' +
      "(with spaceId) to instead get the space's full page hierarchy as a " +
      'nested tree.',
    tier: 'core',
    catalogLine: "listPages — list recent pages, or a space's full page tree.",
    buildShape: (z) => ({
      spaceId: z
        .string()
        .optional()
        .describe('Optional space id to scope the listing to.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of pages (default 50, max 100).'),
      tree: z
        .boolean()
        .optional()
        .describe(
          "When true, return the space's full page hierarchy as a nested tree " +
            '(children arrays) instead of the recent-by-updatedAt flat list. ' +
            'Requires spaceId; ignores limit.',
        ),
    }),
    // `limit ?? 50` / `tree ?? false` are no-op defaults: the client method
    // already defaults limit=50, tree=false, so the old MCP explicit-default form
    // and the in-app pass-through form are byte-identical — one canonical mapping.
    execute: (client, { spaceId, limit, tree }) =>
      client.listPages(
        spaceId as string | undefined,
        (limit as number | undefined) ?? 50,
        (tree as boolean | undefined) ?? false,
      ),
  },

  createPage: {
    mcpName: 'create_page',
    inAppKey: 'createPage',
    description:
      'Create a new page with a Markdown body in a space, optionally under a ' +
      'parent page (omit parentPageId to create at the space root). Returns ' +
      'the new page id and title. Reversible: a page can be moved to trash ' +
      'later.',
    tier: 'deferred',
    catalogLine: 'createPage — create a new page with a Markdown body in a space.',
    // Reconciled schema DRIFT: the MCP copy pinned `content` to .min(1) while
    // the in-app copy left it unbounded and DOCUMENTS an empty body as valid
    // ("may be empty") — creating an empty page to fill in later is a real use
    // case. The looser (no-min) form is kept, so create_page now also accepts an
    // empty body (harmless — it creates an empty page) and no previously-valid
    // in-app input is ever rejected. `title`/`spaceId` keep the MCP .min(1)
    // (an empty title or space is never valid).
    buildShape: (z) => ({
      title: z.string().min(1).describe('The title of the new page.'),
      content: z.string().describe('The page body as Markdown (may be empty).'),
      spaceId: z.string().min(1).describe('The id of the space to create the page in.'),
      parentPageId: z
        .string()
        .optional()
        .describe('Optional parent page id to nest the new page under.'),
    }),
    // MCP wraps the raw create response as JSON. In-app projects `{ id, title }`
    // and defensively coerces a missing body to '' (the schema makes content a
    // required string, so `?? ''` only guards an absent field — preserved).
    execute: (client, { title, content, spaceId, parentPageId }) =>
      client.createPage(
        title as string,
        content as string,
        spaceId as string,
        parentPageId as string | undefined,
      ),
    inAppExecute: async (client, { title, content, spaceId, parentPageId }) => {
      // createPage(title, content, spaceId, parentPageId?) ->
      // { data: filterPage(page, markdown), success }.
      const result = (await client.createPage(
        title as string,
        (content as string | undefined) ?? '',
        spaceId as string,
        parentPageId as string | undefined,
      )) as { data?: { id?: string; slugId?: string; title?: string } };
      const data = result?.data ?? {};
      return { id: data.id ?? data.slugId, title: data.title ?? (title as string) };
    },
  },

  movePage: {
    mcpName: 'move_page',
    inAppKey: 'movePage',
    description:
      'Move a page under a new parent page, or to the space root when no ' +
      'parent is given. Reversible: move it back at any time.',
    tier: 'deferred',
    catalogLine: 'movePage — move a page under a new parent or to the space root.',
    // Reconciled schema DRIFT: the MCP copy exposed a `position` field
    // (fractional-index ordering) that the in-app copy lacked. Unified by
    // KEEPING position (the in-app client already accepts an optional position
    // arg, so the in-app execute now forwards it) — it is optional, so no
    // previously-valid in-app call is rejected. `parentPageId` is `.nullable()`
    // on both, so a real JSON null moves to root on either transport; the MCP
    // execute additionally coerces the strings 'null'/'' to null as a robustness
    // fallback (kept in its execute body, not in the shared schema).
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page to move.'),
      parentPageId: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Target parent page id. Null or omitted moves the page to the space ' +
            'root.',
        ),
      position: z
        .string()
        .min(5)
        .optional()
        .describe(
          'Optional fractional-index position key (min 5 chars); omit to ' +
            'append at the end.',
        ),
    }),
    // The MCP host keeps its robustness guards (coerce 'null'/'' -> null, a cheap
    // self-cycle guard, and a POSITIVE { success: true } confirmation) and its
    // human-readable success envelope — owns its full result, so it is NOT
    // wrapped in jsonContent.
    mcpExecute: async (client, { pageId, parentPageId, position }) => {
      const finalParentId =
        parentPageId === '' || parentPageId === 'null'
          ? null
          : (parentPageId as string | null | undefined);

      // Cheap cycle guard: a page cannot be moved directly under itself.
      // (Deeper descendant-cycle detection is intentionally out of scope.)
      if (finalParentId !== null && finalParentId === pageId) {
        throw new Error('cannot move a page under itself');
      }

      const result = await client.movePage(
        pageId as string,
        finalParentId || null,
        position as string | undefined,
      );

      // Require POSITIVE confirmation: the live /pages/move success shape is
      // exactly { success: true, status: 200 }. An empty body, a 204, or any odd
      // shape lacking success === true must NOT be reported as a successful move.
      if (
        !(
          result &&
          typeof result === 'object' &&
          (result as { success?: unknown }).success === true
        )
      ) {
        throw new Error(
          `Failed to move page ${pageId}: ${JSON.stringify(result)}`,
        );
      }

      return mcpJson({
        message: `Successfully moved page ${pageId} to parent ${finalParentId || 'root'}`,
        result,
      });
    },
    // The in-app host has no guards; it forwards `parentPageId ?? null` + the
    // optional position and projects `{ pageId, parentPageId, moved }`.
    inAppExecute: async (client, { pageId, parentPageId, position }) => {
      await client.movePage(
        pageId as string,
        (parentPageId as string | null | undefined) ?? null,
        position as string | undefined,
      );
      return {
        pageId,
        parentPageId: (parentPageId as string | null | undefined) ?? null,
        moved: true,
      };
    },
  },

  renamePage: {
    mcpName: 'rename_page',
    inAppKey: 'renamePage',
    description:
      'Rename a page (change its title only; the body is untouched, never ' +
      'resent). Reversible: rename back at any time.',
    tier: 'deferred',
    catalogLine: "renamePage — change a page's title only (body untouched).",
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page to rename.'),
      title: z.string().min(1).describe('The new title.'),
    }),
    // MCP wraps the raw rename response; in-app projects `{ pageId, title }`.
    execute: (client, { pageId, title }) =>
      client.renamePage(pageId as string, title as string),
    inAppExecute: async (client, { pageId, title }) => {
      await client.renamePage(pageId as string, title as string);
      return { pageId, title };
    },
  },

  deletePage: {
    mcpName: 'delete_page',
    inAppKey: 'deletePage',
    description:
      'Move a page to the trash — SOFT delete only: the page can be restored ' +
      'from trash and nothing is ever permanently deleted.',
    tier: 'deferred',
    catalogLine: 'deletePage — move a page to trash (soft delete, reversible).',
    // GUARDRAIL preserved (§14 H4): the schema exposes ONLY pageId, so a
    // permanentlyDelete/forceDelete flag can never reach the client through this
    // tool (asserted by ai-chat-tools.service.spec.ts).
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page to move to trash.'),
    }),
    // deletePage(pageId) hits POST /pages/delete with { pageId } only — the
    // soft-delete (trash) path. GUARDRAIL: the schema exposes ONLY pageId, so no
    // permanent/force-delete flag can reach the client on either host (asserted by
    // ai-chat-tools.service.spec.ts). MCP emits a bare success line (owns its full
    // envelope); in-app projects `{ pageId, trashed }`.
    mcpExecute: async (client, { pageId }) => {
      await client.deletePage(pageId as string);
      return {
        content: [
          { type: 'text' as const, text: `Successfully deleted page ${pageId}` },
        ],
      };
    },
    inAppExecute: async (client, { pageId }) => {
      await client.deletePage(pageId as string);
      return { pageId, trashed: true };
    },
  },

  updatePageJson: {
    mcpName: 'update_page_json',
    inAppKey: 'updatePageJson',
    description:
      "Replace a page's content with a raw ProseMirror JSON document (lossless " +
      'write: preserves the block ids, callouts, tables and attributes you pass ' +
      'in). Typical flow: read the page-JSON view -> modify the JSON -> write it back. ' +
      'Keep existing node ids intact so heading anchors and history stay ' +
      'stable. Minimal full-doc example: {"type":"doc","content":[{"type":' +
      '"paragraph","content":[{"type":"text","text":"Hi"}]}]}. `content` may be ' +
      'a JSON object or a JSON string (both accepted), and is OPTIONAL: omit it ' +
      'to update only the title (though prefer the rename-page tool for a title-only ' +
      'change). Supplying neither content nor title is an error. EVERY node, ' +
      'including nested children, must carry a string `type` from the Docmost ' +
      'schema; text leaves are {"type":"text","text":"..."} (a bare ' +
      '{"text":"..."} is rejected up front). Reversible: ' +
      'the previous version is kept in page history.',
    tier: 'deferred',
    catalogLine:
      "updatePageJson — overwrite a page's body with a full ProseMirror document.",
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('ID of the page to update'),
      content: z
        .any()
        .optional()
        .describe(
          'ProseMirror document {"type":"doc","content":[...]} (JSON object or ' +
            'JSON string). Omit to update only the title.',
        ),
      title: z.string().optional().describe('Optional new title'),
    }),
    // Content normalization is identical on both hosts: only parse/validate the
    // document when actually supplied; undefined/null passes straight through so
    // the client performs a title-only (or no-op) update. A string is JSON.parsed
    // (an empty string "" therefore throws), an object passes through unchanged.
    execute: (client, { pageId, content, title }) => {
      let doc: unknown;
      if (content === undefined || content === null) {
        doc = undefined;
      } else {
        doc = parseNodeArg(content, 'content was a string but not valid JSON');
      }
      return client.updatePageJson(pageId as string, doc, title as string | undefined);
    },
  },

  exportPageMarkdown: {
    mcpName: 'export_page_markdown',
    inAppKey: 'exportPageMarkdown',
    // CANONICAL: the MCP copy (a strict superset of the terse in-app wording).
    description:
      'Export a page to a single self-contained, lossless Docmost-flavoured ' +
      'Markdown file (custom extensions): YAML-free meta header, body with ' +
      'inline comment anchors and diagrams, and a trailing comments-thread ' +
      'block. Designed for a download -> edit body -> page-Markdown import ' +
      'round-trip that preserves everything, including comment highlights. ' +
      'Comment THREADS are preserved in the file but are not re-pushed to the ' +
      'server on import.',
    tier: 'deferred',
    catalogLine:
      'exportPageMarkdown — export a page to self-contained Markdown (body + comments).',
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page to export.'),
    }),
    // The markdown is a bare string. MCP returns it as a single text-content
    // element (NOT jsonContent — that would JSON-quote the whole document);
    // in-app projects `{ markdown }`.
    mcpExecute: async (client, { pageId }) => {
      const md = await client.exportPageMarkdown(pageId as string);
      return { content: [{ type: 'text' as const, text: md }] };
    },
    inAppExecute: async (client, { pageId }) => {
      const markdown = await client.exportPageMarkdown(pageId as string);
      return { markdown };
    },
  },

  // --- comment tools (unified from the per-layer inline definitions, #294) ---
  //
  // create_comment and resolve_comment previously carried a "per-transport
  // divergence" note in BOTH layers; #294 unifies their schema + description
  // here. Only the four tools that genuinely exist in BOTH layers live in the
  // registry: create/list/resolve comment and check_new_comments.
  //
  // update_comment and delete_comment are intentionally NOT here: they exist
  // ONLY on the standalone MCP server. The in-app agent deliberately exposes no
  // hard comment edit/delete tool (comment edits are irreversible / not
  // version-tracked; see the guardrail tests in ai-chat-tools.service.spec.ts),
  // so there is nothing to unify — they stay inline in index.ts.

  createComment: {
    mcpName: 'create_comment',
    inAppKey: 'createComment',
    // CANONICAL: the in-app copy (the more-maintained one). It keeps the same
    // rules as the MCP copy — inline-only, top-level requires a `selection`, no
    // page-level comments, replies inherit the anchor, suggestedText must be
    // unique — and adds the "retry with a corrected EXACT selection" and reply-
    // to-reply-rejected guidance the MCP copy lacked. Execute-side validation
    // (reject suggestedText on a reply, require a selection) stays per-layer.
    description:
      'Add an INLINE comment to a page, or reply to an existing top-level ' +
      'comment (one level only — the backend rejects replies to replies). ' +
      'The comment is anchored inline to the given exact `selection` text ' +
      '(which gets highlighted); page-level comments are NOT supported. A ' +
      'new top-level comment REQUIRES a `selection`. Replies inherit the ' +
      "parent's anchor and take no selection. Always COPY the `selection` " +
      'VERBATIM from get_page / search_in_page output — do NOT quote it from ' +
      'memory (stale-memory quoting is the top cause of anchor misses). If the ' +
      'call fails with a "selection not found" error, the error quotes the ' +
      "closest block text (or says the selection spans multiple blocks); retry " +
      "with a corrected EXACT selection copied verbatim from a single " +
      'paragraph/block. You may also attach a ' +
      '`suggestedText` proposing a replacement for the `selection` (a human ' +
      'applies it from the UI); when set, the `selection` must occur exactly ' +
      'once in the page. Reversible via the comment UI.',
    tier: 'core',
    catalogLine:
      'createComment — add an inline comment (optionally with a suggested edit).',
    // Reconciled schema: the field set is identical across both layers; the
    // only constraint drift is `content`, which the MCP copy pinned to
    // .min(1) while the in-app copy left unbounded — the stricter MCP form is
    // kept (an empty comment body is never valid).
    buildShape: (z) => ({
      pageId: z.string().describe('The id of the page to comment on.'),
      content: z.string().min(1).describe('The comment body as Markdown.'),
      selection: z
        .string()
        .min(1)
        .max(250)
        .optional()
        .describe(
          'EXACT contiguous text from a SINGLE paragraph/block to anchor ' +
            '(highlight) the comment on (<=250 chars, avoid spanning across ' +
            'formatting boundaries). Required for a new top-level comment; ' +
            'omit only when replying via parentCommentId.',
        ),
      parentCommentId: z
        .string()
        .optional()
        .describe(
          'Optional id of a TOP-LEVEL comment to reply to (one level ' +
            'of replies only).',
        ),
      suggestedText: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          'Optional proposed replacement (PLAIN TEXT) for the `selection`, ' +
            'applied by a human via the UI (never auto-applied). REQUIRES a ' +
            '`selection`; NOT allowed on a reply. When set, the `selection` ' +
            'must be UNIQUE in the page — expand it with surrounding context ' +
            '(still <=250 chars) if it occurs more than once, or the call is ' +
            'refused.',
        ),
    }),
    // Both hosts enforce the SAME guardrails (a top-level comment requires a
    // selection; suggestedText is forbidden on a reply / without a selection) but
    // with per-layer error wording (snake_case 'create_comment:' on the MCP
    // surface, camelCase 'createComment' in-app) and different result shapes (MCP
    // jsonContent, in-app projects `{ commentId, pageId }`). Preserved byte-for-
    // byte via the two overrides.
    mcpExecute: async (client, { pageId, content, selection, parentCommentId, suggestedText }) => {
      if (!parentCommentId && (!selection || !(selection as string).trim())) {
        throw new Error(
          "create_comment: a 'selection' (exact text to anchor on) is required for a top-level comment; omit it only when replying via parentCommentId.",
        );
      }
      if (suggestedText !== undefined) {
        if (parentCommentId) {
          throw new Error(
            "create_comment: 'suggestedText' cannot be attached to a reply; it applies only to a top-level inline comment.",
          );
        }
        if (!selection || !(selection as string).trim()) {
          throw new Error(
            "create_comment: 'suggestedText' requires a 'selection' to anchor and rewrite.",
          );
        }
      }
      const result = await client.createComment(
        pageId as string,
        content as string,
        'inline',
        selection as string | undefined,
        parentCommentId as string | undefined,
        suggestedText as string | undefined,
      );
      return mcpJson(result);
    },
    inAppExecute: async (client, { pageId, content, selection, parentCommentId, suggestedText }) => {
      if (!parentCommentId && (!selection || !(selection as string).trim())) {
        throw new Error(
          "createComment requires a 'selection' (exact text to anchor on) for a new top-level comment.",
        );
      }
      if (suggestedText !== undefined) {
        if (parentCommentId) {
          throw new Error(
            "createComment: 'suggestedText' cannot be attached to a reply; it applies only to a top-level inline comment.",
          );
        }
        if (!selection || !(selection as string).trim()) {
          throw new Error(
            "createComment: 'suggestedText' requires a 'selection' to anchor and rewrite.",
          );
        }
      }
      const result = (await client.createComment(
        pageId as string,
        content as string,
        'inline',
        selection as string | undefined,
        parentCommentId as string | undefined,
        suggestedText as string | undefined,
      )) as { data?: { id?: string } };
      const data = result?.data ?? {};
      return { commentId: data.id, pageId };
    },
  },

  listComments: {
    mcpName: 'list_comments',
    inAppKey: 'listComments',
    // CANONICAL: the two copies are near-identical; the MCP copy is the
    // superset (it keeps the "(pagination is handled internally)" note the
    // in-app copy dropped), so it is used verbatim.
    description:
      'List comments on a page in one call (pagination is handled ' +
      'internally). By DEFAULT only ACTIVE threads are returned; resolved ' +
      'threads (a resolved top-level comment and all its replies) are hidden ' +
      'and their count reported as `resolvedThreadsHidden` so you can re-query ' +
      'with `includeResolved: true` to see everything. Returns ' +
      '`{ items, resolvedThreadsHidden }`. Content is returned as Markdown.',
    tier: 'core',
    catalogLine:
      'listComments — list all comments on a page (including resolved).',
    buildShape: (z) => ({
      pageId: z.string().describe('ID of the page'),
      includeResolved: z
        .boolean()
        .optional()
        .describe('default only active threads; true — include resolved'),
    }),
    execute: (client, { pageId, includeResolved }) =>
      client.listComments(pageId as string, includeResolved as boolean | undefined),
  },

  resolveComment: {
    mcpName: 'resolve_comment',
    inAppKey: 'resolveComment',
    // CANONICAL: the MCP copy's richer wording, minus its snake_case reference
    // to `delete_comment` (a sibling tool that does NOT exist in the in-app
    // layer) — rephrased transport-neutrally per the registry convention.
    description:
      'Resolve (close) or reopen a top-level comment thread (reversible — ' +
      'pass resolved=false to reopen). Only top-level comments can be ' +
      'resolved; the server rejects resolving a reply. Resolving keeps the ' +
      'thread and its replies intact (it is not a deletion).',
    tier: 'core',
    catalogLine: 'resolveComment — resolve or reopen a comment thread.',
    // Reconciled schema: `resolved` drifted — the MCP copy made it optional
    // with .default(true) (resolve is the common case, documented), the in-app
    // copy made it required. The MCP form is kept (a strict superset: it never
    // rejects a previously-valid input and adds a sensible default), and
    // commentId keeps the MCP copy's stricter .min(1).
    buildShape: (z) => ({
      commentId: z
        .string()
        .min(1)
        .describe('ID of the top-level comment thread to resolve or reopen'),
      resolved: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'true (default) marks the thread resolved/closed; false reopens it',
        ),
    }),
    // MCP wraps the raw resolve response; in-app projects `{ commentId, resolved }`.
    execute: (client, { commentId, resolved }) =>
      client.resolveComment(commentId as string, resolved as boolean),
    inAppExecute: async (client, { commentId, resolved }) => {
      await client.resolveComment(commentId as string, resolved as boolean);
      return { commentId, resolved };
    },
  },

  checkNewComments: {
    mcpName: 'check_new_comments',
    inAppKey: 'checkNewComments',
    // CANONICAL: the MCP copy (the more detailed of the two). The MCP layer's
    // execute-side guard that rejects an unparseable `since` timestamp stays in
    // its execute body (per-layer logic), not in the shared schema.
    description:
      'Check for new comments across pages in a space since a given ' +
      'timestamp. Optionally scope to a page subtree (folder). Returns only ' +
      'comments created after the specified time.',
    tier: 'deferred',
    catalogLine:
      'checkNewComments — find comments in a space created after a timestamp.',
    // Reconciled schema: `since` keeps the MCP copy's stricter .min(1) (the
    // in-app copy left it unbounded); field descriptions use the MCP copy's
    // more detailed wording (it carries an example timestamp).
    buildShape: (z) => ({
      spaceId: z.string().describe('Space ID to check for new comments'),
      since: z
        .string()
        .min(1)
        .describe(
          "ISO 8601 timestamp — only return comments created after this time " +
            "(e.g. '2026-03-10T00:00:00Z')",
        ),
      parentPageId: z
        .string()
        .optional()
        .describe(
          'Optional root page ID to scope the check to a subtree (folder). ' +
            'Only pages under this parent will be checked.',
        ),
    }),
    // The in-app host has NO `since` guard (the canonical execute, raw). The MCP
    // host additionally rejects an unparseable `since` up front — otherwise the
    // NaN comparison silently treats every comment as "not new" and returns zero
    // without signalling the bad input. This guard is a DELIBERATE per-layer
    // difference (the in-app surface never had it), preserved via mcpExecute.
    execute: (client, { spaceId, since, parentPageId }) =>
      client.checkNewComments(
        spaceId as string,
        since as string,
        parentPageId as string | undefined,
      ),
    mcpExecute: async (client, { spaceId, since, parentPageId }) => {
      if (Number.isNaN(Date.parse(since as string))) {
        throw new Error(
          `Invalid 'since' timestamp: ${JSON.stringify(since)} — expected an ISO 8601 date (e.g. '2026-03-10T00:00:00Z')`,
        );
      }
      const result = await client.checkNewComments(
        spaceId as string,
        since as string,
        parentPageId as string | undefined,
      );
      return mcpJson(result);
    },
  },

  // --- table tools (unified from the per-layer inline definitions, #294) ---
  //
  // These tools carried a "NOT shared" note in BOTH layers because of a single
  // parameter-NAME drift: the MCP layer named the table reference `table` while
  // the in-app layer named it `tableRef`. #294 reconciles that drift by unifying
  // on the MCP name `table` — renaming the MCP public parameter would break
  // external MCP clients, whereas the in-app parameter is model-facing
  // (prompt-only) and safe to rename. The in-app execute bodies now destructure
  // `table` instead of `tableRef` (nothing else changes). Descriptions take the
  // MCP copy's richer wording (it documented `#<index>`, padding, header-row
  // behavior) plus the in-app copy's "Reversible via page history" note; sibling
  // tool references are phrased transport-neutrally.
  //
  // NOT here (kept inline in index.ts): table_get / getTable. Its MCP tool name
  // is noun-first (`table_get`) while the in-app key is verb-first (`getTable`),
  // so it breaks the snake_case(inAppKey) naming convention the registry enforces
  // (shared-tool-specs.contract.spec.ts). Renaming the public MCP tool would
  // break external clients, so it stays per-transport (its in-app param was still
  // aligned to `table` for consistency with the migrated trio below).

  tableInsertRow: {
    mcpName: 'table_insert_row',
    inAppKey: 'tableInsertRow',
    description:
      'Insert a row of plain-text cells into a table. `table` is `#<index>` ' +
      'from the page outline, or a block id inside it. `cells` is the text per ' +
      "column (padded to the table's column count; an error if more cells than " +
      'columns). `index` is the 0-based insert position (0 inserts before the ' +
      'header); omit to append at the end. Reversible via page history.',
    tier: 'deferred',
    catalogLine: 'tableInsertRow — insert a row of plain-text cells into a table.',
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page.'),
      table: z
        .string()
        .min(1)
        .describe('"#<index>" from the page outline, or a block id in the table.'),
      cells: z.array(z.string()).describe('The cell texts for the row (one per column).'),
      index: z
        .number()
        .int()
        .optional()
        .describe('0-based insert position (0 inserts before the header); omit to append.'),
    }),
    execute: (client, { pageId, table, cells, index }) =>
      client.tableInsertRow(
        pageId as string,
        table as string,
        cells as string[],
        index as number | undefined,
      ),
  },

  tableDeleteRow: {
    mcpName: 'table_delete_row',
    inAppKey: 'tableDeleteRow',
    description:
      'Delete the row at 0-based `index` from a table (`table` is `#<index>` ' +
      'from the page outline, or a block id inside it). Refuses to delete the ' +
      "table's only row; an out-of-range `index` throws. Deleting `index` 0 " +
      'removes the header row, and the next row becomes the new header. ' +
      'Reversible via page history.',
    tier: 'deferred',
    catalogLine: 'tableDeleteRow — delete a table row at a 0-based index.',
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page.'),
      table: z
        .string()
        .min(1)
        .describe('"#<index>" from the page outline, or a block id in the table.'),
      index: z.number().int().describe('0-based row index to delete.'),
    }),
    execute: (client, { pageId, table, index }) =>
      client.tableDeleteRow(pageId as string, table as string, index as number),
  },

  tableUpdateCell: {
    mcpName: 'table_update_cell',
    inAppKey: 'tableUpdateCell',
    description:
      'Set the plain-text content of cell [row, col] (0-based) in a table ' +
      '(`table` is `#<index>` from the page outline, or a block id inside it). ' +
      "Replaces the cell's content with a single text paragraph; for rich " +
      "formatting, patch the cell's paragraph id (obtained from reading the " +
      'table) instead. Reversible via page history.',
    tier: 'deferred',
    catalogLine: 'tableUpdateCell — set the text of a table cell at [row, col].',
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('The id of the page.'),
      table: z
        .string()
        .min(1)
        .describe('"#<index>" from the page outline, or a block id in the table.'),
      row: z.number().int().describe('0-based row index.'),
      col: z.number().int().describe('0-based column index.'),
      text: z.string().describe('The new cell text.'),
    }),
    execute: (client, { pageId, table, row, col, text }) =>
      client.tableUpdateCell(
        pageId as string,
        table as string,
        row as number,
        col as number,
        text as string,
      ),
  },

  // --- footnote + image write tools (promoted from inline MCP-only, #410) ---
  //
  // These three were previously registered inline in index.ts as MCP-only,
  // because the in-app AI-chat agent had no equivalent. #410 promotes them so the
  // in-app agent (esp. the Researcher role) can attach real footnotes/images
  // instead of writing literal `^[...]` / placeholder text via editPageText. The
  // schema + description are MOVED VERBATIM from the old inline registrations so
  // external MCP clients see identical tool names, fields and text.

  insertFootnote: {
    mcpName: 'insert_footnote',
    inAppKey: 'insertFootnote',
    description:
      'Insert an AUTHOR-INLINE footnote: you specify only WHERE (anchorText) ' +
      'and WHAT (text). The footnote marker is placed right after anchorText in ' +
      'the body, and the bottom footnotes list + the numbering are derived ' +
      'deterministically server-side. You do NOT assign a number, and you ' +
      "never see or edit the footnotes list — so footnotes cannot end up out " +
      "of order, orphaned, or as a raw '[^id]' block. If a footnote with the " +
      'SAME text already exists, its number is REUSED (one definition, several ' +
      "references). The write is atomic and won't clobber concurrent edits; if " +
      'anchorText is not found, nothing is written and an error is returned.',
    // CORE for the in-app agent (#410): keeping it deferred would recreate the
    // original asymmetry (footnote tool hidden while editPageText is core), which
    // is exactly what makes the agent fall back to literal `^[...]`.
    tier: 'core',
    catalogLine:
      'insertFootnote — attach a numbered footnote right after a snippet of existing body text.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      anchorText: z
        .string()
        .min(1)
        .describe(
          'A snippet of existing body text; the footnote marker is inserted ' +
            'immediately after its first occurrence (mark-safe).',
        ),
      text: z
        .string()
        .min(1)
        .describe('The footnote content as markdown (becomes the definition).'),
    }),
    execute: (client, { pageId, anchorText, text }) =>
      client.insertFootnote(pageId as string, anchorText as string, text as string),
  },

  insertImage: {
    mcpName: 'insert_image',
    inAppKey: 'insertImage',
    description:
      'Download an image from a web (http/https) URL and insert it into ' +
      'a page in one step. By default ' +
      'appends the image at the end of the page. With replaceText, replaces the ' +
      'first top-level block whose text contains that string (handy for ' +
      'swapping a text placeholder like "[image: foo.png]" for the real image). ' +
      'With afterText, inserts the image right after the first block containing ' +
      'that string. Preserves all other block ids.',
    tier: 'deferred',
    catalogLine:
      'insertImage — download a web image and insert it into a page.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      imageUrl: z
        .string()
        .min(1)
        .describe('http(s) URL of the image to download and upload'),
      align: z.enum(['left', 'center', 'right']).optional(),
      alt: z.string().optional(),
      replaceText: z
        .string()
        .optional()
        .describe(
          'Replace the first top-level block whose text contains this string with the image',
        ),
      afterText: z
        .string()
        .optional()
        .describe(
          'Insert the image right after the first top-level block whose text contains this string',
        ),
    }),
    execute: (client, { pageId, imageUrl, align, alt, replaceText, afterText }) =>
      client.insertImage(pageId as string, imageUrl as string, {
        align: align as 'left' | 'center' | 'right' | undefined,
        alt: alt as string | undefined,
        replaceText: replaceText as string | undefined,
        afterText: afterText as string | undefined,
      }),
  },

  replaceImage: {
    mcpName: 'replace_image',
    inAppKey: 'replaceImage',
    description:
      'Replace an existing image on a page with a new image fetched from a web ' +
      '(http/https) URL: uploads the new file as a NEW ' +
      'attachment (fresh clean URL that renders and busts browser caches), then ' +
      'repoints every image node referencing the old attachmentId (recursively, ' +
      'incl. callouts/tables) via the live document, preserving comments, ' +
      'alignment and alt. The old attachment is left as an unreferenced orphan ' +
      '(Docmost has no API to delete a single attachment; it is removed only when ' +
      'the page/space is deleted). In-place byte overwrite is avoided because some ' +
      'Docmost versions corrupt the attachment (HTTP 500) on overwrite.',
    tier: 'deferred',
    catalogLine:
      'replaceImage — swap an existing page image for one fetched from a web URL.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      attachmentId: z
        .string()
        .min(1)
        .describe('attachmentId of the image currently in the page to replace'),
      imageUrl: z
        .string()
        .min(1)
        .describe('http(s) URL of the new image to download'),
      align: z.enum(['left', 'center', 'right']).optional(),
      alt: z.string().optional(),
    }),
    execute: (client, { pageId, attachmentId, imageUrl, align, alt }) =>
      client.replaceImage(pageId as string, attachmentId as string, imageUrl as string, {
        align: align as 'left' | 'center' | 'right' | undefined,
        alt: alt as string | undefined,
      }),
  },

  // --- draw.io diagrams (issue #423 stage 1, #424 stage 2) ---

  drawioGet: {
    mcpName: 'drawio_get',
    inAppKey: 'drawioGet',
    description:
      'Read a draw.io diagram on a page as mxGraph XML (default) or as its raw ' +
      '`.drawio.svg`. `node` is the drawio node\'s attrs.id (from get_outline / ' +
      'get_page_json) or "#<index>" for a top-level block. Returns the decoded ' +
      'mxGraphModel XML plus meta { attachmentId, title, width, height, ' +
      'cellCount, hash }. `hash` is the optimistic-lock key you MUST pass back ' +
      'as baseHash to drawio_update. Diagrams a human saved from the editor ' +
      '(including draw.io\'s compressed format) decode losslessly.',
    tier: 'deferred',
    catalogLine:
      'drawioGet — read a draw.io diagram as mxGraph XML (+ hash for updates).',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      node: z
        .string()
        .min(1)
        .describe('The drawio node attrs.id, or "#<index>" for a top-level block.'),
      format: z
        .enum(['xml', 'svg'])
        .optional()
        .describe('"xml" (default) for mxGraph XML, or "svg" for the raw .drawio.svg.'),
    }),
    execute: (client, { pageId, node, format }) =>
      client.drawioGet(
        pageId as string,
        node as string,
        (format as 'xml' | 'svg' | undefined) ?? 'xml',
      ),
  },

  drawioCreate: {
    mcpName: 'drawio_create',
    inAppKey: 'drawioCreate',
    description:
      'Create a draw.io diagram from mxGraph XML and insert it as a diagram ' +
      'block. `xml` is a bare `<mxGraphModel>` OR a list of `<mxCell>` elements ' +
      '(the server wraps it and adds the id=0 / id=1 sentinel cells). The XML is ' +
      'LINTED first (well-formedness, sentinel cells, unique ids, vertex XOR ' +
      'edge, every edge has a child <mxGeometry as="geometry"/>, edge ' +
      'source/target and every parent resolve, style parses, no XML comments, ' +
      'value escaping) — a violation returns a structured error naming the rule ' +
      'and cellId so you can fix and retry. `where` positions the block like ' +
      'insert_node: position before/after (with exactly one of anchorNodeId or ' +
      'anchorText) or append. Returns { nodeId, attachmentId, warnings }. The ' +
      'returned `nodeId` is an index-based "#<index>" handle (drawio nodes carry ' +
      'no attrs.id): it addresses the new top-level block and can be fed straight ' +
      'back into drawio_get / drawio_update for THIS document. It is positional, ' +
      'so if you add or remove blocks before it, re-resolve via get_outline. The ' +
      'diagram is editable in the draw.io editor and can be re-read with ' +
      'drawio_get.' +
      DRAWIO_HARD_RULES,
    tier: 'deferred',
    catalogLine:
      'drawioCreate — create a draw.io diagram from mxGraph XML and insert it.',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      xml: z
        .string()
        .min(1)
        .describe(
          'mxGraph XML: a bare <mxGraphModel> or a list of <mxCell> elements.',
        ),
      position: z
        .enum(['before', 'after', 'append'])
        .describe('Where to insert relative to the anchor.'),
      anchorNodeId: z
        .string()
        .optional()
        .describe('Anchor block id (for before/after).'),
      anchorText: z
        .string()
        .optional()
        .describe('Anchor text fragment (for before/after).'),
      title: z.string().optional().describe('Optional diagram title.'),
      layout: z
        .enum(['elk'])
        .optional()
        .describe(
          'Optional: "elk" runs an ELK layered auto-layout (honouring nested ' +
            'containers) and rewrites all coordinates — give rough placement and ' +
            'let the server compute pixels.',
        ),
    }),
    // The flat schema fields are regrouped into the client's `where` object.
    // `layout` is the 5th arg: dropping it silently disables ELK auto-layout
    // (a reviewed #440 parity fix — MUST reach the client on both hosts).
    execute: (client, { pageId, xml, position, anchorNodeId, anchorText, title, layout }) =>
      client.drawioCreate(
        pageId as string,
        {
          position: position as 'before' | 'after' | 'append',
          anchorNodeId: anchorNodeId as string | undefined,
          anchorText: anchorText as string | undefined,
        },
        xml as string,
        title as string | undefined,
        layout as 'elk' | undefined,
      ),
  },

  drawioUpdate: {
    mcpName: 'drawio_update',
    inAppKey: 'drawioUpdate',
    description:
      'Replace a draw.io diagram\'s content with new mxGraph XML (same lint ' +
      'pipeline as drawio_create). `baseHash` is MANDATORY: pass the hash from ' +
      'the drawio_get you based the edit on. If the diagram changed since ' +
      '(a human or another agent edited it) the hash mismatches and the update ' +
      'is refused with a conflict error — re-read with drawio_get and retry. On ' +
      'success it overwrites the diagram attachment and updates the node ' +
      'width/height. `node` is the drawio node attrs.id or "#<index>".' +
      DRAWIO_HARD_RULES,
    tier: 'deferred',
    catalogLine:
      'drawioUpdate — replace a draw.io diagram (optimistic-locked by baseHash).',
    buildShape: (z) => ({
      pageId: z.string().min(1),
      node: z
        .string()
        .min(1)
        .describe('The drawio node attrs.id, or "#<index>" for a top-level block.'),
      xml: z
        .string()
        .min(1)
        .describe(
          'New mxGraph XML: a bare <mxGraphModel> or a list of <mxCell> elements.',
        ),
      baseHash: z
        .string()
        .min(1)
        .describe('The meta.hash from the drawio_get this edit is based on.'),
      layout: z
        .enum(['elk'])
        .optional()
        .describe(
          'Optional: "elk" runs an ELK layered auto-layout and rewrites all ' +
            'coordinates before writing.',
        ),
    }),
    // `layout` is the 5th arg: forward layout:"elk" (a reviewed #440 parity fix)
    // so both hosts run the ELK auto-layout before writing.
    execute: (client, { pageId, node, xml, baseHash, layout }) =>
      client.drawioUpdate(
        pageId as string,
        node as string,
        xml as string,
        baseHash as string,
        layout as 'elk' | undefined,
      ),
  },

  drawioShapes: {
    mcpName: 'drawio_shapes',
    inAppKey: 'drawioShapes',
    description:
      'Look up VERIFIED draw.io stencil style-strings so you never guess a ' +
      '`shape=mxgraph.*` name (a wrong name renders as an EMPTY BOX). Searches a ' +
      'bundled catalog of ~10 400 shapes (the jgraph/drawio-mcp index) by ' +
      'substring, tags and loose fuzzy match, plus a curated overlay for AWS ' +
      'icons: it returns the correct resIcon for rebranded services (OpenSearch ' +
      '-> elasticsearch_service, MSK -> managed_streaming_for_kafka, VPC Peering ' +
      '-> peering, IAM Identity Center -> single_sign_on) and maps known-broken ' +
      'stencils to working replacements (e.g. dynamodb_table -> dynamodb) with a ' +
      'note. Each hit is { style, w, h, title, type, category?, note? } — copy ' +
      '`style` verbatim onto the cell and use w/h as the default size. Call this ' +
      'BEFORE drawio_create/drawio_update whenever you need a specific icon ' +
      '(AWS/Azure/GCP/network/UML/flowchart).',
    tier: 'deferred',
    catalogLine:
      'drawioShapes — look up verified draw.io stencil style-strings (no empty boxes).',
    buildShape: (z) => ({
      query: z
        .string()
        .min(1)
        .describe('What to find, e.g. "lambda", "s3", "azure cosmos", "vpc group".'),
      category: z
        .string()
        .optional()
        .describe('Optional filter, e.g. an AWS category name ("Compute").'),
      limit: z
        .number()
        .optional()
        .describe('Max results (default 12, capped at 50).'),
    }),
    // PURE helper — searchShapes reads the bundled catalog, no client method and
    // no network. The `client` arg is ignored. The raw `{ query, count, results }`
    // is identical on both hosts (MCP wraps it as jsonContent via the loop, the
    // in-app host returns it as-is), so a single canonical execute serves both —
    // no per-host override needed.
    execute: async (_client, { query, category, limit }) => {
      const results = searchShapes(query as string, {
        category: category as string | undefined,
        limit: limit as number | undefined,
      });
      return { query, count: results.length, results };
    },
  },

  drawioGuide: {
    mcpName: 'drawio_guide',
    inAppKey: 'drawioGuide',
    description:
      'Progressive-disclosure draw.io authoring reference. Call with a `section` ' +
      'to pull one focused, <=4KB chapter instead of bloating context: ' +
      '"skeleton" (canonical mxGraph XML, sentinels, the accepted inputs, hard ' +
      'rules), "layout" (spacing heuristics, edge routing, the layout:"elk" ' +
      'option, the quality warnings), "containers" (transparent groups, relative ' +
      'child coords, cross-container edges, swimlanes), "icons-aws" (the ' +
      'service/resource icon patterns, category colors, rebrandings, blocklist), ' +
      '"icons-azure" (portable image-style paths). Omit `section` to get the ' +
      'index of sections. Pair with drawio_shapes for exact stencil styles.',
    tier: 'deferred',
    catalogLine:
      'drawioGuide — on-demand draw.io authoring reference (skeleton/layout/containers/icons).',
    buildShape: (z) => ({
      section: z
        .enum(['skeleton', 'layout', 'containers', 'icons-aws', 'icons-azure'])
        .optional()
        .describe('Which section to read; omit for the section index.'),
    }),
    // PURE helper — getGuideSection returns a bundled authoring chapter, no client
    // method and no network. The `client` arg is ignored. The raw guide object is
    // identical on both hosts (MCP wraps it as jsonContent via the loop, the
    // in-app host returns it as-is), so a single canonical execute serves both.
    execute: async (_client, { section }) =>
      getGuideSection(section as string | undefined),
  },
} satisfies Record<string, SharedToolSpec>;
