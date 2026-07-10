import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { DocmostClient, DocmostMcpConfig } from "./client.js";
import { parseNodeArg } from "./lib/parse-node-arg.js";
import { SHARED_TOOL_SPECS, SharedToolSpec } from "./tool-specs.js";

// Re-export the client and its config type so embedding hosts (e.g. the gitmost
// NestJS server) can `import('@docmost/mcp')` and construct a DocmostClient
// directly — for the credentials variant OR the per-user getToken variant.
export { DocmostClient } from "./client.js";
export type { DocmostMcpConfig } from "./client.js";

// Teardown for the live per-page CollabSession cache (issue #400). An embedding
// HTTP host (the gitmost NestJS server) should call this from its own shutdown
// hook so no cached collab provider outlives the process.
export { destroyAllSessions } from "./lib/collab-session.js";

// Re-export the zod-agnostic shared tool-spec registry so the in-app AI-SDK
// service can read it off the loaded module (it cannot import the ESM package's
// internals directly; it goes through loadDocmostMcp()).
export { SHARED_TOOL_SPECS } from "./tool-specs.js";
export type { SharedToolSpec } from "./tool-specs.js";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

// Configuration for an MCP server instance is the DocmostMcpConfig union
// (credentials OR getToken) defined and re-exported above. The factory below is
// fully side-effect-free on import: it reads no environment variables and opens
// no transport. The standalone stdio entrypoint (stdio.ts) and the HTTP handler
// (http.ts) supply this config and own the process/transport lifecycle.

// --- Modern McpServer Implementation ---

// Editing guide surfaced to MCP clients in the initialize result so they can
// pick the right tool by intent and avoid resending whole documents.
//
// MAINTENANCE RULE: when you ADD, RENAME, or REMOVE a tool (either an inline
// server.registerTool(...) here or a spec in tool-specs.ts), you MUST update
// this guide so the new tool is routed by intent. This is enforced by
// test/unit/server-instructions.test.mjs, which fails when a registered tool
// name is not mentioned below (see its EXCEPTIONS list for the rare opt-outs).
// Exported for that test.
export const SERVER_INSTRUCTIONS =
  "Docmost editing guide — choose the tool by intent.\n" +
  "READ: find a page -> search (workspace-wide full-text); list -> list_pages / list_spaces. Locate blocks and their ids CHEAPLY -> get_outline (compact top-level map; start here, not get_page_json). One block's subtree -> get_node (by attrs.id, or \"#<index>\" for tables, which carry no id). Find every occurrence of a string/regex ON a page (and where each is) -> search_in_page, NOT block-by-block get_node — it returns each hit's node ref + block index + context for a targeted comment. Whole page -> get_page (Markdown, lossy; inline <span data-comment-id> tags are comment anchors — markup, not text) or get_page_json (lossless ProseMirror with block ids). Hand a huge page (with images) to an external consumer without pulling it through the model context -> stash_page (returns a short-lived anonymous URL).\n" +
  "EDIT: fix wording/typos/numbers -> edit_page_text (find/replace inside blocks, no node id needed). Change ONE block (paragraph/heading/callout/etc.) structurally -> patch_node (by attrs.id from get_outline). Add a block -> insert_node (before/after a block by attrs.id or by anchor text, or append). Remove a block -> delete_node (by attrs.id). Tables -> table_get / table_update_cell / table_insert_row / table_delete_row (address by \"#<index>\" from get_outline; table nodes have no attrs.id). Images -> insert_image (add from a web URL) / replace_image (swap an existing image). Footnotes -> insert_footnote. Bulk/structural rewrite -> update_page_json (full ProseMirror replace; prefer the granular tools above to avoid resending the whole ~100KB+ document). Complex/scripted rewrite (multiple coordinated edits, renumbering) -> docmost_transform: write a JS `(doc, ctx) => doc` transform, preview the diff with dryRun (default), then apply with dryRun:false; ctx.helpers includes commentsToFootnotes for turning inline comments into numbered footnotes.\n" +
  "PAGES: new -> create_page (Markdown). Rename (title only) -> rename_page. Move -> move_page. Delete -> delete_page (SOFT delete — the page goes to trash and is restorable; nothing is permanent). Copy/replace a page's whole content from another page (server-side, no document through the model) -> copy_page_content. Sharing -> share_page / unshare_page / list_shares; share_page makes the page PUBLICLY accessible — do it only when explicitly asked.\n" +
  "COMMENTS: create_comment is always inline and requires an EXACT selection — contiguous text from a single block, <=250 chars (fails rather than leaving an unanchored comment); reply to a thread via parentCommentId. Propose a concrete text fix for one-click human approval -> create_comment with suggestedText (the exact plain-text replacement for the selection; the selection must then be UNIQUE in the page — extend it with context if needed); prefer this over editing directly when the change is subjective or needs the author's sign-off. Manage -> list_comments, update_comment, resolve_comment (resolve/reopen, reversible — prefer over delete to close), delete_comment, check_new_comments.\n" +
  "HISTORY: review what changed -> diff_page_versions (a historyId vs current, or two versions). List saved versions -> list_page_history. Undo a bad edit -> restore_page_version (writes a past version back as current; itself revertible). Lossless markdown round-trip (download, edit, re-upload, incl. comment anchors) -> export_page_markdown / import_page_markdown.";

// Helper to format JSON responses
const jsonContent = (data: any) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Create a fully configured Docmost MCP server. Side-effect-free: it does not
 * read environment variables and does not connect any transport — the caller
 * decides how to expose it (stdio or HTTP). The client talks to Docmost over
 * REST + the collaboration WebSocket using the provided service-account
 * credentials and auto-re-authenticates.
 */
/**
 * Wrap a tool handler so its wall-clock duration is reported through the host's
 * dependency-neutral sink as `mcp_tool_duration_seconds` (labelled by tool
 * name). Pure and side-effect-free apart from the optional `onMetric` call:
 *  - preserves the handler's exact return value (awaited);
 *  - observes in a `finally`, so it records on BOTH success and throw, then
 *    rethrows the original error unchanged (never swallowed);
 *  - with no `onMetric` (standalone/stdio) it is a transparent pass-through.
 * Exported so the timing contract can be unit-tested without a live transport.
 */
export function timeToolHandler(
  name: string,
  handler: (...args: any[]) => any,
  onMetric?: (name: string, value: number, labels?: Record<string, string>) => void,
): (...args: any[]) => Promise<any> {
  return async (...handlerArgs: any[]) => {
    const start = performance.now();
    try {
      return await handler(...handlerArgs);
    } finally {
      onMetric?.("mcp_tool_duration_seconds", (performance.now() - start) / 1000, {
        tool: name,
      });
    }
  };
}

export function createDocmostMcpServer(config: DocmostMcpConfig): McpServer {
  // Pass the whole config union through: the client branches internally on
  // credentials vs. getToken, so both the external /mcp (creds) and the
  // internal per-user (getToken) paths are wired here unchanged.
  const docmostClient = new DocmostClient(config);

  const server = new McpServer(
    {
      name: "docmost-mcp",
      version: VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Single choke point for MCP tool timing. Both `registerShared` (below) and
  // the inline `server.registerTool(...)` calls funnel through this one method,
  // so monkeypatching it HERE — before any tool is registered and before
  // `registerShared` captures a reference to it — times every tool with no
  // per-tool boilerplate. The wrapped handler records wall-clock duration and,
  // in a `finally`, feeds the host's dependency-neutral sink
  // `config.onMetric("mcp_tool_duration_seconds", seconds, { tool })`. The tool
  // name is the registration name (bounded cardinality). When no onMetric is
  // provided (standalone/stdio) the wrapper is a pure pass-through: it still
  // returns the original result and rethrows the original error unchanged.
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: any[]
  ) => any;
  (server as any).registerTool = (...args: any[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1];
    const timedHandler = timeToolHandler(name, handler, config.onMetric);
    return originalRegisterTool(...args.slice(0, -1), timedHandler);
  };

  // Register a tool from the shared, zod-agnostic spec registry. The spec owns
  // the canonical name + model-facing description + (optional) schema builder;
  // only the execute body is supplied per call. buildShape is invoked with THIS
  // package's zod (v3); the in-app layer passes its own zod (v4).
  //
  // The spec's schema builder returns a plain ZodRawShape (Record<string,
  // unknown> in the shared module since it must stay zod-agnostic), so the
  // McpServer.registerTool overloads cannot infer the execute arg's shape from
  // it. We type `execute` loosely and cast the call through `any`; runtime
  // behaviour is unchanged — each execute body destructures the same fields the
  // builder declares.
  const registerShared = (
    spec: SharedToolSpec,
    execute: (args: any) => Promise<{ content: { type: "text"; text: string }[] }>,
  ) =>
    (server.registerTool as any)(
      spec.mcpName,
      spec.buildShape
        ? { description: spec.description, inputSchema: spec.buildShape(z) }
        : { description: spec.description },
      execute,
    );

  // Tool: get_workspace
  registerShared(SHARED_TOOL_SPECS.getWorkspace, async () => {
    const workspace = await docmostClient.getWorkspace();
    return jsonContent(workspace);
  });

  // Tool: list_spaces
  registerShared(SHARED_TOOL_SPECS.listSpaces, async () => {
    const spaces = await docmostClient.getSpaces();
    return jsonContent(spaces);
  });

// Tool: list_pages
// INTENTIONAL per-transport divergence (not in the shared registry): this
// transport exposes a `tree:true` mode that returns the full nested hierarchy;
// the in-app copy keeps the same tree option but is worded for the in-app agent.
// Kept per-layer so each side can tune its own guidance.
// Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294). This
// transport keeps applying its own defaults (limit=50, tree=false) in execute.
registerShared(SHARED_TOOL_SPECS.listPages, async ({ spaceId, limit, tree }) => {
  const result = await docmostClient.listPages(spaceId, limit ?? 50, tree ?? false);
  return jsonContent(result);
});

// Tool: get_page
// Schema + description now live in the shared registry (#294).
registerShared(SHARED_TOOL_SPECS.getPage, async ({ pageId }) => {
  const page = await docmostClient.getPage(pageId);
  return jsonContent(page);
});

// Tool: get_page_json
registerShared(SHARED_TOOL_SPECS.getPageJson, async ({ pageId }) => {
  const page = await docmostClient.getPageJson(pageId);
  return jsonContent(page);
});

// Tool: get_outline
registerShared(SHARED_TOOL_SPECS.getOutline, async ({ pageId }) => {
  const result = await docmostClient.getOutline(pageId);
  return jsonContent(result);
});

// Tool: get_node
registerShared(SHARED_TOOL_SPECS.getNode, async ({ pageId, nodeId }) => {
  const result = await docmostClient.getNode(pageId, nodeId);
  return jsonContent(result);
});

// Tool: search_in_page
registerShared(
  SHARED_TOOL_SPECS.searchInPage,
  async ({ pageId, query, regex, caseSensitive, limit }) => {
    const result = await docmostClient.searchInPage(pageId, query, {
      regex,
      caseSensitive,
      limit,
    });
    return jsonContent(result);
  },
);

// Tool: table_get
// NOT in the shared registry: the MCP tool name `table_get` is noun-first while
// the in-app key is `getTable` (verb-first), breaking the snake_case(inAppKey)
// convention the shared registry enforces (shared-tool-specs.contract.spec.ts).
// Renaming the public MCP tool would break external clients, so it stays inline.
server.registerTool(
  "table_get",
  {
    description:
      "Read a table as a matrix. Returns {rows, cols, cells (text[][]), " +
      "cellIds (paragraph id per cell, or null)}. `table` = `#<index>` from " +
      "get_outline, or any block id inside the table. Use cellIds with " +
      "patch_node for rich-formatted cell edits. `cols` is the FIRST row's " +
      "width; ragged tables may vary per row, so use the per-row length of " +
      "`cells` for each row.",
    inputSchema: {
      pageId: z.string().min(1),
      table: z.string().min(1),
    },
  },
  async ({ pageId, table }) => {
    const result = await docmostClient.getTable(pageId, table);
    return jsonContent(result);
  },
);

// Tool: table_insert_row
// Schema + description now live in the shared registry (#294); the `table`
// parameter name is the canonical one (the in-app layer was unified to it).
registerShared(
  SHARED_TOOL_SPECS.tableInsertRow,
  async ({ pageId, table, cells, index }) => {
    const result = await docmostClient.tableInsertRow(
      pageId,
      table,
      cells,
      index,
    );
    return jsonContent(result);
  },
);

// Tool: table_delete_row
// Schema + description now live in the shared registry (#294).
registerShared(
  SHARED_TOOL_SPECS.tableDeleteRow,
  async ({ pageId, table, index }) => {
    const result = await docmostClient.tableDeleteRow(pageId, table, index);
    return jsonContent(result);
  },
);

// Tool: table_update_cell
// Schema + description now live in the shared registry (#294).
registerShared(
  SHARED_TOOL_SPECS.tableUpdateCell,
  async ({ pageId, table, row, col, text }) => {
    const result = await docmostClient.tableUpdateCell(
      pageId,
      table,
      row,
      col,
      text,
    );
    return jsonContent(result);
  },
);

// Tool: create_page
// Schema + description now live in the shared registry (#294).
registerShared(
  SHARED_TOOL_SPECS.createPage,
  async ({ title, content, spaceId, parentPageId }) => {
    const result = await docmostClient.createPage(
      title,
      content,
      spaceId,
      parentPageId,
    );
    return jsonContent(result);
  },
);

// Tool: update_page_json
// Schema + description now live in the shared registry (#294). The execute body
// keeps this transport's content normalization (parse a JSON-string content,
// pass undefined/null through for a title-only/no-op update).
registerShared(
  SHARED_TOOL_SPECS.updatePageJson,
  async ({ pageId, content, title }) => {
    // Only parse/validate the document when it was actually supplied; when it
    // is omitted, pass it straight through so the client performs a title-only
    // (or no-op) update.
    let doc;
    if (content === undefined || content === null) {
      doc = undefined;
    } else {
      // String -> JSON.parse (throwing on invalid); object passes through.
      doc = parseNodeArg(content, "content was a string but not valid JSON");
    }
    const result = await docmostClient.updatePageJson(pageId, doc, title);
    return jsonContent(result);
  },
);

// Tool: export_page_markdown
// Schema + description now live in the shared registry (#294).
registerShared(SHARED_TOOL_SPECS.exportPageMarkdown, async ({ pageId }) => {
  const md = await docmostClient.exportPageMarkdown(pageId);
  return { content: [{ type: "text" as const, text: md }] };
});

// Tool: import_page_markdown
registerShared(
  SHARED_TOOL_SPECS.importPageMarkdown,
  async ({ pageId, markdown }) => {
    const res = await docmostClient.importPageMarkdown(pageId, markdown);
    return jsonContent(res);
  },
);

// Tool: copy_page_content
registerShared(
  SHARED_TOOL_SPECS.copyPageContent,
  async ({ sourcePageId, targetPageId }) => {
    const result = await docmostClient.copyPageContent(
      sourcePageId,
      targetPageId,
    );
    return jsonContent(result);
  },
);

// Tool: rename_page
// Schema + description now live in the shared registry (#294).
registerShared(SHARED_TOOL_SPECS.renamePage, async ({ pageId, title }) => {
  const result = await docmostClient.renamePage(pageId, title);
  return jsonContent(result);
});

// Tool: edit_page_text
registerShared(SHARED_TOOL_SPECS.editPageText, async ({ pageId, edits }) => {
  const result = await docmostClient.editPageText(pageId, edits);
  return jsonContent(result);
});

// Tool: stash_page — returns a resource_link (NOT embedded text) so the doc
// body never enters the model context. Registered directly (not via
// registerShared) because that helper only emits text content. Also returns
// `structuredContent` carrying the full documented `{uri, sha256, size, images}`
// shape alongside the resource_link, so MCP clients receive the blob's sha256
// (its ETag, for integrity) and mirror counts, not just the link.
server.registerTool(
  SHARED_TOOL_SPECS.stashPage.mcpName,
  {
    description: SHARED_TOOL_SPECS.stashPage.description,
    inputSchema: SHARED_TOOL_SPECS.stashPage.buildShape!(z),
  },
  async ({ pageId }: { pageId: string }) => {
    const result = await docmostClient.stashPage(pageId);
    return {
      content: [
        {
          type: "resource_link" as const,
          uri: result.uri,
          name: "page.json",
          mimeType: "application/json",
          size: result.size,
        },
      ],
      // Mirror the full documented result shape ({ uri, size, sha256, images })
      // as structuredContent so MCP clients get the blob's sha256 (its ETag, for
      // integrity) and the mirror counts, not just the resource_link.
      structuredContent: {
        uri: result.uri,
        sha256: result.sha256,
        size: result.size,
        images: result.images,
      },
    };
  },
);

// Tool: patch_node — schema + description from the shared registry (identical
// across both transports). The execute body keeps its own parseNodeArg
// normalization (the model sometimes serializes `node` as a JSON string).
registerShared(
  SHARED_TOOL_SPECS.patchNode,
  async ({ pageId, nodeId, node }) => {
    const parsedNode = parseNodeArg(node);
    const result = await docmostClient.patchNode(pageId, nodeId, parsedNode);
    return jsonContent(result);
  },
);

// Tool: insert_node — schema + description from the shared registry. As with
// patch_node, the execute body retains parseNodeArg on the incoming node.
registerShared(
  SHARED_TOOL_SPECS.insertNode,
  async ({ pageId, node, position, anchorNodeId, anchorText }) => {
    const parsedNode = parseNodeArg(node);
    const result = await docmostClient.insertNode(pageId, parsedNode, {
      position,
      anchorNodeId,
      anchorText,
    });
    return jsonContent(result);
  },
);

// Tool: delete_node
registerShared(SHARED_TOOL_SPECS.deleteNode, async ({ pageId, nodeId }) => {
  const result = await docmostClient.deleteNode(pageId, nodeId);
  return jsonContent(result);
});

// Tool: insert_image
// Schema + description now live in the shared registry (#410) so BOTH this MCP
// server and the in-app AI-chat agent expose it. The execute body is unchanged.
registerShared(
  SHARED_TOOL_SPECS.insertImage,
  async ({ pageId, imageUrl, align, alt, replaceText, afterText }) => {
    const result = await docmostClient.insertImage(pageId, imageUrl, {
      align,
      alt,
      replaceText,
      afterText,
    });
    return jsonContent(result);
  },
);

// Tool: replace_image
// Schema + description now live in the shared registry (#410).
registerShared(
  SHARED_TOOL_SPECS.replaceImage,
  async ({ pageId, attachmentId, imageUrl, align, alt }) => {
    const result = await docmostClient.replaceImage(
      pageId,
      attachmentId,
      imageUrl,
      {
        align,
        alt,
      },
    );
    return jsonContent(result);
  },
);

// Tool: share_page
// Schema + description now live in the shared registry (#294). The execute body
// keeps this transport's own `searchIndexing ?? true` default.
registerShared(
  SHARED_TOOL_SPECS.sharePage,
  async ({ pageId, searchIndexing }) => {
    const result = await docmostClient.sharePage(pageId, searchIndexing ?? true);
    return jsonContent(result);
  },
);

// Tool: unshare_page
registerShared(SHARED_TOOL_SPECS.unsharePage, async ({ pageId }) => {
  const result = await docmostClient.unsharePage(pageId);
  return jsonContent(result);
});

// Tool: list_shares
registerShared(SHARED_TOOL_SPECS.listShares, async () => {
  const result = await docmostClient.listShares();
  return jsonContent(result);
});

// Tool: move_page
// Schema + description now live in the shared registry (#294). The execute body
// keeps this transport's cycle guard, its 'null'/'' -> null string coercion, and
// its positive-confirmation check on the move response.
registerShared(
  SHARED_TOOL_SPECS.movePage,
  async ({ pageId, parentPageId, position }) => {
    const finalParentId =
      parentPageId === "" || parentPageId === "null" ? null : parentPageId;

    // Cheap cycle guard: a page cannot be moved directly under itself.
    // (Deeper descendant-cycle detection is intentionally out of scope.)
    if (finalParentId !== null && finalParentId === pageId) {
      throw new Error("cannot move a page under itself");
    }

    const result = await docmostClient.movePage(
      pageId,
      finalParentId || null,
      position,
    );

    // Require POSITIVE confirmation: the live /pages/move success shape is
    // exactly { success: true, status: 200 }. An empty body, a 204, or any odd
    // shape lacking success === true must NOT be reported as a successful move,
    // so we surface the raw API result instead of declaring success.
    if (!(result && typeof result === "object" && result.success === true)) {
      throw new Error(
        `Failed to move page ${pageId}: ${JSON.stringify(result)}`,
      );
    }

    return jsonContent({
      message: `Successfully moved page ${pageId} to parent ${finalParentId || "root"}`,
      result,
    });
  },
);

// Tool: delete_page
// Schema + description now live in the shared registry (#294). The shared schema
// exposes ONLY pageId, so no permanent/force-delete flag can reach the client.
registerShared(SHARED_TOOL_SPECS.deletePage, async ({ pageId }) => {
  await docmostClient.deletePage(pageId);
  return {
    content: [
      { type: "text" as const, text: `Successfully deleted page ${pageId}` },
    ],
  };
});

// --- Comment tools (ported from upstream PR #3 by Max Nikitin) ---

// Tool: list_comments
registerShared(
  SHARED_TOOL_SPECS.listComments,
  async ({ pageId, includeResolved }) => {
    const comments = await docmostClient.listComments(pageId, includeResolved);
    return jsonContent(comments);
  },
);

// Tool: create_comment
// Schema + description now live in the shared registry (#294). The execute body
// keeps this transport's own guards (require a selection for a top-level
// comment; reject suggestedText on a reply / without a selection).
registerShared(
  SHARED_TOOL_SPECS.createComment,
  async ({ pageId, content, selection, parentCommentId, suggestedText }) => {
    if (!parentCommentId && (!selection || !selection.trim())) {
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
      if (!selection || !selection.trim()) {
        throw new Error(
          "create_comment: 'suggestedText' requires a 'selection' to anchor and rewrite.",
        );
      }
    }
    const result = await docmostClient.createComment(
      pageId,
      content,
      "inline",
      selection,
      parentCommentId,
      suggestedText,
    );
    return jsonContent(result);
  },
);

// Tool: update_comment
server.registerTool(
  "update_comment",
  {
    description:
      "Update an existing comment's content. Only the comment creator can " +
      "update it. Content is provided as Markdown.",
    inputSchema: {
      commentId: z.string().min(1).describe("ID of the comment to update"),
      content: z
        .string()
        .min(1)
        .describe("New comment content in Markdown format"),
    },
  },
  async ({ commentId, content }) => {
    const result = await docmostClient.updateComment(commentId, content);
    return jsonContent(result);
  },
);

// Tool: delete_comment
server.registerTool(
  "delete_comment",
  {
    description:
      "Delete a comment. Only the comment creator or space admin can delete it.",
    inputSchema: {
      commentId: z.string().min(1).describe("ID of the comment to delete"),
    },
  },
  async ({ commentId }) => {
    await docmostClient.deleteComment(commentId);
    return {
      content: [
        {
          type: "text" as const,
          text: `Successfully deleted comment ${commentId}`,
        },
      ],
    };
  },
);

// Tool: resolve_comment
// Schema + description now live in the shared registry (#294).
registerShared(
  SHARED_TOOL_SPECS.resolveComment,
  async ({ commentId, resolved }) => {
    const result = await docmostClient.resolveComment(commentId, resolved);
    return jsonContent(result);
  },
);

// Tool: check_new_comments
// Schema + description now live in the shared registry (#294). The execute body
// keeps this transport's own guard rejecting an unparseable `since` timestamp.
registerShared(
  SHARED_TOOL_SPECS.checkNewComments,
  async ({ spaceId, since, parentPageId }) => {
    // Reject an unparseable timestamp up front: otherwise the comparison
    // against NaN silently treats every comment as "not new" and the tool
    // returns zero results without signalling the bad input.
    if (Number.isNaN(Date.parse(since))) {
      throw new Error(
        `Invalid 'since' timestamp: ${JSON.stringify(since)} — expected an ISO 8601 date (e.g. '2026-03-10T00:00:00Z')`,
      );
    }
    const result = await docmostClient.checkNewComments(
      spaceId,
      since,
      parentPageId,
    );
    return jsonContent(result);
  },
);

// Tool: search
// INTENTIONAL per-transport divergence (not shared): the in-app `searchPages`
// runs a semantic + keyword hybrid (RRF) with in-process access control and a
// different schema (limit 1-20); this transport is a plain REST full-text search
// (limit up to 100). Different behaviour AND schema, so kept per-layer.
server.registerTool(
  "search",
  {
    description:
      "Full-text search for pages and content across the whole workspace. " +
      "Results are bounded by `limit` (1-100; when omitted the server applies " +
      "its own default).",
    inputSchema: {
      query: z.string().min(1).describe("Search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results to return (max 100)"),
    },
  },
  async ({ query, limit }) => {
    // The tool exposes no spaceId filter, so pass undefined for the client's
    // optional spaceId parameter and forward limit into its correct slot.
    const result = await docmostClient.search(query, undefined, limit);
    return jsonContent(result);
  },
);

// Tool: docmost_transform
// INTENTIONAL per-transport divergence (not shared): the in-app `transformPage`
// deliberately omits the `deleteComments` schema field (comment-deletion
// guardrail) and carries a much shorter description; this transport exposes the
// full helper catalogue. Different schema, so kept per-layer.
server.registerTool(
  "docmost_transform",
  {
    description:
      "Edit a page by running an arbitrary JS transform `(doc, ctx) => doc` " +
      "against its LIVE ProseMirror document, with a diff preview and page " +
      "history as the safety net. By default dryRun=true: returns a diff " +
      "preview WITHOUT writing. Set dryRun=false to apply (atomic, won't " +
      "clobber concurrent edits). `doc` is the lossless ProseMirror document " +
      "({type:'doc',content:[...]}); return a new doc of the same shape. " +
      "`ctx` gives you: comments (the page's comments, each {id, content " +
      "(markdown), selection, type}); log (array; console.log pushes to it); " +
      "consume(id) (mark a comment id as consumed — those are deleted when " +
      "deleteComments=true after a successful apply); and helpers: " +
      "blockText(node) (plain text), walk(node, fn) (depth-first over all " +
      "nodes incl. callouts/tables/lists), getList(doc, predicate) (find a " +
      "node even without attrs.id), insertMarkerAfter(doc, anchor, marker, " +
      "{beforeBlock}) (insert a plain unmarked text run after anchor, " +
      "mark-safe), setCalloutRange(doc, n) (sync a [1]…[K] callout range to " +
      "[1]…[n]), noteItem(inlineNodes) (wrap inline nodes in a listItem with a " +
      "fresh id), mdToInlineNodes(markdown) (comment markdown -> inline nodes), " +
      "commentsToFootnotes(doc, comments, {notesHeading}) (turn inline " +
      "comments into numbered footnotes), canonicalizeFootnotes(doc) (derive " +
      "footnote numbering + the single bottom list from reference order, drop " +
      "orphans/duplicates — runs AUTOMATICALLY on the transform RESULT, so the " +
      "applied (and dryRun-previewed) doc is always footnote-canonical; a dryRun " +
      "diff may therefore show footnote tidy-ups your script did not make, and " +
      "it is idempotent after the first run), and " +
      "insertInlineFootnote(doc, {anchorText, text}) (author-inline footnote: " +
      "marker + dedup'd definition, list derived). Footnote convention: markers are " +
      "plain '[N]' text in the body; the notes are an orderedList under a " +
      "heading whose text is 'Примечания переводчика' (that is only the DEFAULT " +
      "notesHeading — pass the notesHeading option to the helpers to use a " +
      "heading matching the page's language). The transform runs " +
      "sandboxed (no require/process/fs/network, 5s timeout) and must return a " +
      "{type:'doc'} node.",
    inputSchema: {
      pageId: z.string().min(1),
      transformJs: z
        .string()
        .min(1)
        .describe(
          "A JS function `(doc, ctx) => doc` (expression-arrow or " +
            "parenthesized function). It receives a clone of the live doc and " +
            "ctx (comments, log, consume(id), helpers: blockText/walk/getList/" +
            "insertMarkerAfter/setCalloutRange/noteItem/mdToInlineNodes/" +
            "commentsToFootnotes/canonicalizeFootnotes/insertInlineFootnote) " +
            "and must return a {type:'doc'} node.",
        ),
      dryRun: z
        .boolean()
        .optional()
        .default(true)
        .describe("Preview only (no write) when true (default)."),
      deleteComments: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "After a successful apply, delete every comment id passed to " +
            "ctx.consume(id).",
        ),
    },
  },
  async ({ pageId, transformJs, dryRun, deleteComments }) => {
    const result = await docmostClient.transformPage(pageId, transformJs, {
      dryRun,
      deleteComments,
    });
    return jsonContent(result);
  },
);

// Tool: insert_footnote
// Schema + description now live in the shared registry (#410) so the in-app
// AI-chat agent exposes it too. The execute body is unchanged.
registerShared(
  SHARED_TOOL_SPECS.insertFootnote,
  async ({ pageId, anchorText, text }) => {
    const result = await docmostClient.insertFootnote(pageId, anchorText, text);
    return jsonContent(result);
  },
);

// Tool: diff_page_versions
registerShared(
  SHARED_TOOL_SPECS.diffPageVersions,
  async ({ pageId, from, to }) => {
    const result = await docmostClient.diffPageVersions(pageId, from, to);
    return jsonContent(result);
  },
);

// Tool: list_page_history
registerShared(
  SHARED_TOOL_SPECS.listPageHistory,
  async ({ pageId, cursor }) => {
    const result = await docmostClient.listPageHistory(pageId, cursor);
    return jsonContent(result);
  },
);

// Tool: restore_page_version
registerShared(
  SHARED_TOOL_SPECS.restorePageVersion,
  async ({ historyId }) => {
    const result = await docmostClient.restorePageVersion(historyId);
    return jsonContent(result);
  },
);

  return server;
}
