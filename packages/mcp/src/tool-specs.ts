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
// MAINTENANCE RULE: adding, renaming, or removing a spec here (or an inline
// registerTool in index.ts) REQUIRES updating SERVER_INSTRUCTIONS in
// packages/mcp/src/index.ts — the intent-routing guide MCP clients receive on
// initialize. Enforced by test/unit/server-instructions.test.mjs.

// Loose on purpose — see the comment above. The two zod majors expose different
// static type surfaces, so typing this precisely would couple the registry to
// one of them. Each builder uses only the common, stable subset of the API.
type ZodLike = any;

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
}

export const SHARED_TOOL_SPECS = {
  // --- no-argument read tools ---

  getWorkspace: {
    mcpName: 'get_workspace',
    inAppKey: 'getWorkspace',
    description: 'Fetch metadata about the current workspace (name, settings).',
    tier: 'core',
    catalogLine: 'getWorkspace — fetch current workspace metadata (name, settings).',
  },

  listSpaces: {
    mcpName: 'list_spaces',
    inAppKey: 'listSpaces',
    description:
      'List the spaces the current user can access. Returns the array of ' +
      'spaces (id, name, slug, ...).',
    tier: 'core',
    catalogLine: 'listSpaces — list the spaces the user can access (id, name, slug).',
  },

  listShares: {
    mcpName: 'list_shares',
    inAppKey: 'listShares',
    description:
      'List all public shares in the workspace with page titles and public URLs.',
    tier: 'deferred',
    catalogLine: 'listShares — list all public shares in the workspace with their URLs.',
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
      'JSON object or a JSON string (both accepted). Cheaper and safer than ' +
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
      '{"type":"text","text":"x","marks":[{"type":"bold"}]}. The node may be a ' +
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
  },

  // --- share management ---

  unsharePage: {
    mcpName: 'unshare_page',
    inAppKey: 'unsharePage',
    description: 'Remove the public share of a page (revokes the public URL).',
    tier: 'deferred',
    catalogLine: "unsharePage — revoke a page's public share (removes the public URL).",
    buildShape: (z) => ({
      pageId: z.string().min(1).describe('ID of the page to unshare'),
    }),
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
      "parent's anchor and take no selection. If the call fails with a " +
      '"selection not found" error, retry with a corrected EXACT selection ' +
      'copied verbatim from a single paragraph/block. You may also attach a ' +
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
  },
} satisfies Record<string, SharedToolSpec>;
