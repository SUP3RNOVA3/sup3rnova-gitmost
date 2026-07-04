import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { DocmostClient } from "./client.js";
import { parseNodeArg } from "./lib/parse-node-arg.js";
import { SHARED_TOOL_SPECS } from "./tool-specs.js";
// Re-export the client and its config type so embedding hosts (e.g. the gitmost
// NestJS server) can `import('@docmost/mcp')` and construct a DocmostClient
// directly — for the credentials variant OR the per-user getToken variant.
export { DocmostClient } from "./client.js";
// Re-export the zod-agnostic shared tool-spec registry so the in-app AI-SDK
// service can read it off the loaded module (it cannot import the ESM package's
// internals directly; it goes through loadDocmostMcp()).
export { SHARED_TOOL_SPECS } from "./tool-specs.js";
// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
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
export const SERVER_INSTRUCTIONS = "Docmost editing guide — choose the tool by intent.\n" +
    "READ: find a page -> search (workspace-wide full-text); list -> list_pages / list_spaces. Locate blocks and their ids CHEAPLY -> get_outline (compact top-level map; start here, not get_page_json). One block's subtree -> get_node (by attrs.id, or \"#<index>\" for tables, which carry no id). Find every occurrence of a string/regex ON a page (and where each is) -> search_in_page, NOT block-by-block get_node — it returns each hit's node ref + block index + context for a targeted comment. Whole page -> get_page (Markdown, lossy; inline <span data-comment-id> tags are comment anchors — markup, not text) or get_page_json (lossless ProseMirror with block ids). Hand a huge page (with images) to an external consumer without pulling it through the model context -> stash_page (returns a short-lived anonymous URL).\n" +
    "EDIT: fix wording/typos/numbers -> edit_page_text (find/replace inside blocks, no node id needed). Change ONE block (paragraph/heading/callout/etc.) structurally -> patch_node (by attrs.id from get_outline). Add a block -> insert_node (before/after a block by attrs.id or by anchor text, or append). Remove a block -> delete_node (by attrs.id). Tables -> table_get / table_update_cell / table_insert_row / table_delete_row (address by \"#<index>\" from get_outline; table nodes have no attrs.id). Images -> insert_image (add from a web URL) / replace_image (swap an existing image). Footnotes -> insert_footnote. Bulk/structural rewrite -> update_page_json (full ProseMirror replace; prefer the granular tools above to avoid resending the whole ~100KB+ document). Complex/scripted rewrite (multiple coordinated edits, renumbering) -> docmost_transform: write a JS `(doc, ctx) => doc` transform, preview the diff with dryRun (default), then apply with dryRun:false; ctx.helpers includes commentsToFootnotes for turning inline comments into numbered footnotes.\n" +
    "PAGES: new -> create_page (Markdown). Rename (title only) -> rename_page. Move -> move_page. Delete -> delete_page (SOFT delete — the page goes to trash and is restorable; nothing is permanent). Copy/replace a page's whole content from another page (server-side, no document through the model) -> copy_page_content. Sharing -> share_page / unshare_page / list_shares; share_page makes the page PUBLICLY accessible — do it only when explicitly asked.\n" +
    "COMMENTS: create_comment is always inline and requires an EXACT selection — contiguous text from a single block, <=250 chars (fails rather than leaving an unanchored comment); reply to a thread via parentCommentId. Propose a concrete text fix for one-click human approval -> create_comment with suggestedText (the exact plain-text replacement for the selection; the selection must then be UNIQUE in the page — extend it with context if needed); prefer this over editing directly when the change is subjective or needs the author's sign-off. Manage -> list_comments, update_comment, resolve_comment (resolve/reopen, reversible — prefer over delete to close), delete_comment, check_new_comments.\n" +
    "HISTORY: review what changed -> diff_page_versions (a historyId vs current, or two versions). List saved versions -> list_page_history. Undo a bad edit -> restore_page_version (writes a past version back as current; itself revertible). Lossless markdown round-trip (download, edit, re-upload, incl. comment anchors) -> export_page_markdown / import_page_markdown.";
// Helper to format JSON responses
const jsonContent = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
/**
 * Create a fully configured Docmost MCP server. Side-effect-free: it does not
 * read environment variables and does not connect any transport — the caller
 * decides how to expose it (stdio or HTTP). The client talks to Docmost over
 * REST + the collaboration WebSocket using the provided service-account
 * credentials and auto-re-authenticates.
 */
export function createDocmostMcpServer(config) {
    // Pass the whole config union through: the client branches internally on
    // credentials vs. getToken, so both the external /mcp (creds) and the
    // internal per-user (getToken) paths are wired here unchanged.
    const docmostClient = new DocmostClient(config);
    const server = new McpServer({
        name: "docmost-mcp",
        version: VERSION,
    }, { instructions: SERVER_INSTRUCTIONS });
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
    const registerShared = (spec, execute) => server.registerTool(spec.mcpName, spec.buildShape
        ? { description: spec.description, inputSchema: spec.buildShape(z) }
        : { description: spec.description }, execute);
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
    server.registerTool("list_pages", {
        description: "List most recent pages in a space ordered by updatedAt (descending). " +
            "Returns a bounded list (default 50, max 100) — use search for lookups " +
            "in large spaces. Pass tree:true (with spaceId) to instead get the " +
            "space's full page hierarchy as a nested tree.",
        inputSchema: {
            spaceId: z.string().optional(),
            limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .optional()
                .describe("Max pages to return (default 50, max 100)"),
            tree: z
                .boolean()
                .optional()
                .describe("When true, return the space's full page hierarchy as a nested tree (each node has a children array) instead of the recent-by-updatedAt flat list. Requires spaceId; ignores limit."),
        },
    }, async ({ spaceId, limit, tree }) => {
        const result = await docmostClient.listPages(spaceId, limit ?? 50, tree ?? false);
        return jsonContent(result);
    });
    // Tool: get_page
    server.registerTool("get_page", {
        description: "Get page details with content converted to Markdown. The conversion is " +
            "LOSSY (block ids, exact table/callout structure are approximated); for a " +
            "lossless representation use get_page_json. Inline <span data-comment-id> " +
            "tags in the markdown are comment highlight anchors (also present for " +
            "RESOLVED threads) — treat them as markup, not page text.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
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
    registerShared(SHARED_TOOL_SPECS.searchInPage, async ({ pageId, query, regex, caseSensitive, limit }) => {
        const result = await docmostClient.searchInPage(pageId, query, {
            regex,
            caseSensitive,
            limit,
        });
        return jsonContent(result);
    });
    // Tool: table_get
    server.registerTool("table_get", {
        description: "Read a table as a matrix. Returns {rows, cols, cells (text[][]), " +
            "cellIds (paragraph id per cell, or null)}. `table` = `#<index>` from " +
            "get_outline, or any block id inside the table. Use cellIds with " +
            "patch_node for rich-formatted cell edits. `cols` is the FIRST row's " +
            "width; ragged tables may vary per row, so use the per-row length of " +
            "`cells` for each row.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
        },
    }, async ({ pageId, table }) => {
        const result = await docmostClient.getTable(pageId, table);
        return jsonContent(result);
    });
    // Tool: table_insert_row
    // NOT in the shared registry: this transport names the table argument `table`,
    // while the in-app tool names it `tableRef` (ai-chat-tools.service.ts). Sharing
    // one buildShape would rename a public MCP parameter, so the table row/cell
    // tools stay per-transport by design.
    server.registerTool("table_insert_row", {
        description: "Insert a row of plain-text cells into a table. `table` = `#<index>` or " +
            "a block id inside it. `cells` = text per column (padded to the table's " +
            "column count; error if more cells than columns). `index` = 0-based " +
            "insert position (0 inserts before the header); omit to append at the end.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
            cells: z.array(z.string()),
            index: z.number().int().optional(),
        },
    }, async ({ pageId, table, cells, index }) => {
        const result = await docmostClient.tableInsertRow(pageId, table, cells, index);
        return jsonContent(result);
    });
    // Tool: table_delete_row
    // NOT shared — same `table` (here) vs `tableRef` (in-app) parameter-name
    // divergence as table_insert_row.
    server.registerTool("table_delete_row", {
        description: "Delete the row at 0-based `index` from a table (`table` = `#<index>` or " +
            "a block id inside it). Refuses to delete the table's only row. An " +
            "out-of-range `index` throws. Deleting `index` 0 removes the header row, " +
            "and the next row becomes the new header.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
            index: z.number().int(),
        },
    }, async ({ pageId, table, index }) => {
        const result = await docmostClient.tableDeleteRow(pageId, table, index);
        return jsonContent(result);
    });
    // Tool: table_update_cell
    // NOT shared — same `table` (here) vs `tableRef` (in-app) parameter-name
    // divergence as table_insert_row.
    server.registerTool("table_update_cell", {
        description: "Set the plain-text content of cell [row,col] (0-based) in a table " +
            "(`table` = `#<index>` or a block id inside it). Replaces the cell's " +
            "content with a single text paragraph; for rich formatting use patch_node " +
            "on the cell's paragraph id from table_get.",
        inputSchema: {
            pageId: z.string().min(1),
            table: z.string().min(1),
            row: z.number().int(),
            col: z.number().int(),
            text: z.string(),
        },
    }, async ({ pageId, table, row, col, text }) => {
        const result = await docmostClient.tableUpdateCell(pageId, table, row, col, text);
        return jsonContent(result);
    });
    // Tool: create_page
    server.registerTool("create_page", {
        description: "Create a new page from Markdown in a space. Pass parentPageId to nest " +
            "it under a parent; omit it to create at the space root.",
        inputSchema: {
            title: z.string().min(1).describe("Title of the page"),
            content: z.string().min(1).describe("Markdown content"),
            spaceId: z.string().min(1),
            parentPageId: z
                .string()
                .optional()
                .describe("Optional parent page ID to nest under"),
        },
    }, async ({ title, content, spaceId, parentPageId }) => {
        const result = await docmostClient.createPage(title, content, spaceId, parentPageId);
        return jsonContent(result);
    });
    // Tool: update_page_json
    server.registerTool("update_page_json", {
        description: "Replace a page's content with a raw ProseMirror JSON document " +
            "(lossless write: preserves the block ids, callouts, tables and " +
            "attributes you pass in). Typical flow: get_page_json -> modify the " +
            "JSON -> update_page_json. Keep existing node ids intact so heading " +
            "anchors and history stay stable. Minimal full-doc example: " +
            '{"type":"doc","content":[{"type":"paragraph","content":' +
            '[{"type":"text","text":"Hi"}]}]}. `content` may be a JSON object or a ' +
            "JSON string (both accepted), and is OPTIONAL: omit it to update only " +
            "the title (though prefer rename_page for a title-only change). " +
            "Supplying neither content nor title is an error.",
        inputSchema: {
            pageId: z.string().min(1).describe("ID of the page to update"),
            content: z
                .any()
                .optional()
                .describe('ProseMirror document {"type":"doc","content":[...]} (JSON object or ' +
                "JSON string). Omit to rename only."),
            title: z.string().optional().describe("Optional new title"),
        },
    }, async ({ pageId, content, title }) => {
        // Only parse/validate the document when it was actually supplied; when it
        // is omitted, pass it straight through so the client performs a title-only
        // (or no-op) update.
        let doc;
        if (content === undefined || content === null) {
            doc = undefined;
        }
        else {
            // String -> JSON.parse (throwing on invalid); object passes through.
            doc = parseNodeArg(content, "content was a string but not valid JSON");
        }
        const result = await docmostClient.updatePageJson(pageId, doc, title);
        return jsonContent(result);
    });
    // Tool: export_page_markdown
    server.registerTool("export_page_markdown", {
        description: "Export a page to a single self-contained, lossless Docmost-flavoured " +
            "Markdown file (custom extensions): YAML-free meta header, body with " +
            "inline comment anchors and diagrams, and a trailing comments-thread " +
            "block. Designed for a download -> edit body -> import_page_markdown " +
            "round-trip that preserves everything, including comment highlights. " +
            "Comment THREADS are preserved in the file but are not re-pushed to the " +
            "server on import.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
        const md = await docmostClient.exportPageMarkdown(pageId);
        return { content: [{ type: "text", text: md }] };
    });
    // Tool: import_page_markdown
    registerShared(SHARED_TOOL_SPECS.importPageMarkdown, async ({ pageId, markdown }) => {
        const res = await docmostClient.importPageMarkdown(pageId, markdown);
        return jsonContent(res);
    });
    // Tool: copy_page_content
    registerShared(SHARED_TOOL_SPECS.copyPageContent, async ({ sourcePageId, targetPageId }) => {
        const result = await docmostClient.copyPageContent(sourcePageId, targetPageId);
        return jsonContent(result);
    });
    // Tool: rename_page
    server.registerTool("rename_page", {
        description: "Rename a page (change its title only) without touching or resending " +
            "its content.",
        inputSchema: {
            pageId: z.string().min(1).describe("ID of the page to rename"),
            title: z.string().min(1).describe("New title"),
        },
    }, async ({ pageId, title }) => {
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
    server.registerTool(SHARED_TOOL_SPECS.stashPage.mcpName, {
        description: SHARED_TOOL_SPECS.stashPage.description,
        inputSchema: SHARED_TOOL_SPECS.stashPage.buildShape(z),
    }, async ({ pageId }) => {
        const result = await docmostClient.stashPage(pageId);
        return {
            content: [
                {
                    type: "resource_link",
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
    });
    // Tool: patch_node — schema + description from the shared registry (identical
    // across both transports). The execute body keeps its own parseNodeArg
    // normalization (the model sometimes serializes `node` as a JSON string).
    registerShared(SHARED_TOOL_SPECS.patchNode, async ({ pageId, nodeId, node }) => {
        const parsedNode = parseNodeArg(node);
        const result = await docmostClient.patchNode(pageId, nodeId, parsedNode);
        return jsonContent(result);
    });
    // Tool: insert_node — schema + description from the shared registry. As with
    // patch_node, the execute body retains parseNodeArg on the incoming node.
    registerShared(SHARED_TOOL_SPECS.insertNode, async ({ pageId, node, position, anchorNodeId, anchorText }) => {
        const parsedNode = parseNodeArg(node);
        const result = await docmostClient.insertNode(pageId, parsedNode, {
            position,
            anchorNodeId,
            anchorText,
        });
        return jsonContent(result);
    });
    // Tool: delete_node
    registerShared(SHARED_TOOL_SPECS.deleteNode, async ({ pageId, nodeId }) => {
        const result = await docmostClient.deleteNode(pageId, nodeId);
        return jsonContent(result);
    });
    // Tool: insert_image
    server.registerTool("insert_image", {
        description: "Download an image from a web (http/https) URL and insert it into " +
            "a page in one step. By default " +
            "appends the image at the end of the page. With replaceText, replaces the " +
            "first top-level block whose text contains that string (handy for " +
            'swapping a text placeholder like "[image: foo.png]" for the real image). ' +
            "With afterText, inserts the image right after the first block containing " +
            "that string. Preserves all other block ids.",
        inputSchema: {
            pageId: z.string().min(1),
            imageUrl: z
                .string()
                .min(1)
                .describe("http(s) URL of the image to download and upload"),
            align: z.enum(["left", "center", "right"]).optional(),
            alt: z.string().optional(),
            replaceText: z
                .string()
                .optional()
                .describe("Replace the first top-level block whose text contains this string with the image"),
            afterText: z
                .string()
                .optional()
                .describe("Insert the image right after the first top-level block whose text contains this string"),
        },
    }, async ({ pageId, imageUrl, align, alt, replaceText, afterText }) => {
        const result = await docmostClient.insertImage(pageId, imageUrl, {
            align,
            alt,
            replaceText,
            afterText,
        });
        return jsonContent(result);
    });
    // Tool: replace_image
    server.registerTool("replace_image", {
        description: "Replace an existing image on a page with a new image fetched from a web " +
            "(http/https) URL: uploads the new file as a NEW " +
            "attachment (fresh clean URL that renders and busts browser caches), then " +
            "repoints every image node referencing the old attachmentId (recursively, " +
            "incl. callouts/tables) via the live document, preserving comments, " +
            "alignment and alt. The old attachment is left as an unreferenced orphan " +
            "(Docmost has no API to delete a single attachment; it is removed only when " +
            "the page/space is deleted). In-place byte overwrite is avoided because some " +
            "Docmost versions corrupt the attachment (HTTP 500) on overwrite.",
        inputSchema: {
            pageId: z.string().min(1),
            attachmentId: z
                .string()
                .min(1)
                .describe("attachmentId of the image currently in the page to replace"),
            imageUrl: z
                .string()
                .min(1)
                .describe("http(s) URL of the new image to download"),
            align: z.enum(["left", "center", "right"]).optional(),
            alt: z.string().optional(),
        },
    }, async ({ pageId, attachmentId, imageUrl, align, alt }) => {
        const result = await docmostClient.replaceImage(pageId, attachmentId, imageUrl, {
            align,
            alt,
        });
        return jsonContent(result);
    });
    // Tool: share_page
    // INTENTIONAL per-transport divergence (not shared): the in-app copy adds a
    // security-confirmation framing ("only share when the user explicitly asked,
    // since this exposes the page to anyone with the link") tuned for the in-app
    // agent; this transport keeps the plain public-URL wording.
    server.registerTool("share_page", {
        description: "Make a page publicly accessible (idempotent) and return its public " +
            "URL. The URL format is <app>/share/<key>/p/<slugId>. This exposes the " +
            "page content to ANYONE with the URL — do it only when explicitly asked.",
        inputSchema: {
            pageId: z.string().min(1).describe("ID of the page to share"),
            searchIndexing: z
                .boolean()
                .optional()
                .describe("Allow search engines to index the page (default true)"),
        },
    }, async ({ pageId, searchIndexing }) => {
        const result = await docmostClient.sharePage(pageId, searchIndexing ?? true);
        return jsonContent(result);
    });
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
    server.registerTool("move_page", {
        description: "Move a page under a new parent (nesting) or to the space root.",
        inputSchema: {
            pageId: z.string().min(1),
            parentPageId: z
                .string()
                .nullable()
                .optional()
                .describe("Target parent page ID. Pass 'null' or empty string to move to root."),
            position: z
                .string()
                .min(5)
                .optional()
                .describe("fractional-index position key; min 5 chars; omit to append at the end."),
        },
    }, async ({ pageId, parentPageId, position }) => {
        const finalParentId = parentPageId === "" || parentPageId === "null" ? null : parentPageId;
        // Cheap cycle guard: a page cannot be moved directly under itself.
        // (Deeper descendant-cycle detection is intentionally out of scope.)
        if (finalParentId !== null && finalParentId === pageId) {
            throw new Error("cannot move a page under itself");
        }
        const result = await docmostClient.movePage(pageId, finalParentId || null, position);
        // Require POSITIVE confirmation: the live /pages/move success shape is
        // exactly { success: true, status: 200 }. An empty body, a 204, or any odd
        // shape lacking success === true must NOT be reported as a successful move,
        // so we surface the raw API result instead of declaring success.
        if (!(result && typeof result === "object" && result.success === true)) {
            throw new Error(`Failed to move page ${pageId}: ${JSON.stringify(result)}`);
        }
        return jsonContent({
            message: `Successfully moved page ${pageId} to parent ${finalParentId || "root"}`,
            result,
        });
    });
    // Tool: delete_page
    server.registerTool("delete_page", {
        description: "Delete a single page by ID. SOFT delete only: the page is moved to " +
            "trash and can be restored; nothing is permanently deleted.",
        inputSchema: {
            pageId: z.string().min(1),
        },
    }, async ({ pageId }) => {
        await docmostClient.deletePage(pageId);
        return {
            content: [
                { type: "text", text: `Successfully deleted page ${pageId}` },
            ],
        };
    });
    // --- Comment tools (ported from upstream PR #3 by Max Nikitin) ---
    // Tool: list_comments
    server.registerTool("list_comments", {
        description: "List ALL comments on a page in one call (pagination is handled " +
            "internally), including RESOLVED threads — filter by resolvedAt when you " +
            "need only open ones. Content is returned as Markdown.",
        inputSchema: {
            pageId: z.string().describe("ID of the page"),
        },
    }, async ({ pageId }) => {
        const comments = await docmostClient.listComments(pageId);
        return jsonContent(comments);
    });
    // Tool: create_comment
    // INTENTIONAL per-transport divergence (not shared): the in-app copy tunes the
    // guidance for the in-app agent (e.g. "retry with a corrected EXACT selection"
    // and "Reversible via the comment UI"); this transport keeps its own wording.
    server.registerTool("create_comment", {
        description: "Create a new comment on a page. The comment is ALWAYS inline and is " +
            "anchored to (highlights) its `selection` text — there are no page-level " +
            "comments. Content is provided as Markdown and automatically converted. " +
            "A top-level comment REQUIRES an exact `selection`; if the selection " +
            "cannot be found in the page the call fails (no orphan comment is left). " +
            "Replies (parentCommentId set) inherit the parent's anchor and take no " +
            "selection. You may also attach a `suggestedText` proposing a replacement " +
            "for the `selection`; a human applies (or rejects) it from the UI. When " +
            "`suggestedText` is set the `selection` MUST occur exactly once in the " +
            "page — expand it with surrounding context if it is ambiguous.",
        inputSchema: {
            pageId: z.string().describe("ID of the page to comment on"),
            content: z.string().min(1).describe("Comment content in Markdown format"),
            selection: z
                .string()
                .min(1)
                // Enforce the documented 250-char cap to match the description above.
                .max(250)
                .optional()
                .describe("EXACT contiguous text from a single paragraph/block to anchor the " +
                "comment on (<=250 chars). Required for a top-level comment; omit " +
                "only when replying via parentCommentId."),
            parentCommentId: z
                .string()
                .optional()
                .describe("Parent comment ID to create a reply (max 2 nesting levels)"),
            suggestedText: z
                .string()
                .min(1)
                .max(2000)
                .optional()
                .describe("Optional proposed replacement (PLAIN TEXT) for the `selection`, " +
                "applied by a human via the UI (never auto-applied). REQUIRES a " +
                "`selection`; NOT allowed on a reply. When set, the `selection` must " +
                "be UNIQUE in the page — expand it with surrounding context (still " +
                "<=250 chars) if it occurs more than once, or the call is refused."),
        },
    }, async ({ pageId, content, selection, parentCommentId, suggestedText }) => {
        if (!parentCommentId && (!selection || !selection.trim())) {
            throw new Error("create_comment: a 'selection' (exact text to anchor on) is required for a top-level comment; omit it only when replying via parentCommentId.");
        }
        if (suggestedText !== undefined) {
            if (parentCommentId) {
                throw new Error("create_comment: 'suggestedText' cannot be attached to a reply; it applies only to a top-level inline comment.");
            }
            if (!selection || !selection.trim()) {
                throw new Error("create_comment: 'suggestedText' requires a 'selection' to anchor and rewrite.");
            }
        }
        const result = await docmostClient.createComment(pageId, content, "inline", selection, parentCommentId, suggestedText);
        return jsonContent(result);
    });
    // Tool: update_comment
    server.registerTool("update_comment", {
        description: "Update an existing comment's content. Only the comment creator can " +
            "update it. Content is provided as Markdown.",
        inputSchema: {
            commentId: z.string().min(1).describe("ID of the comment to update"),
            content: z
                .string()
                .min(1)
                .describe("New comment content in Markdown format"),
        },
    }, async ({ commentId, content }) => {
        const result = await docmostClient.updateComment(commentId, content);
        return jsonContent(result);
    });
    // Tool: delete_comment
    server.registerTool("delete_comment", {
        description: "Delete a comment. Only the comment creator or space admin can delete it.",
        inputSchema: {
            commentId: z.string().min(1).describe("ID of the comment to delete"),
        },
    }, async ({ commentId }) => {
        await docmostClient.deleteComment(commentId);
        return {
            content: [
                {
                    type: "text",
                    text: `Successfully deleted comment ${commentId}`,
                },
            ],
        };
    });
    // Tool: resolve_comment
    server.registerTool("resolve_comment", {
        description: "Resolve (close) or reopen a comment thread. Only top-level comments can " +
            "be resolved — the server rejects resolving a reply. Reversible: pass " +
            "resolved=false to reopen. Resolving keeps the thread and its replies " +
            "(unlike delete_comment, which permanently removes them).",
        inputSchema: {
            commentId: z
                .string()
                .min(1)
                .describe("ID of the top-level comment thread to resolve or reopen"),
            resolved: z
                .boolean()
                .optional()
                .default(true)
                .describe("true (default) marks the thread resolved/closed; false reopens it"),
        },
    }, async ({ commentId, resolved }) => {
        const result = await docmostClient.resolveComment(commentId, resolved);
        return jsonContent(result);
    });
    // Tool: check_new_comments
    server.registerTool("check_new_comments", {
        description: "Check for new comments across pages in a space since a given timestamp. " +
            "Optionally scope to a page subtree (folder). Returns only comments " +
            "created after the specified time.",
        inputSchema: {
            spaceId: z.string().describe("Space ID to check for new comments"),
            since: z
                .string()
                .min(1)
                .describe("ISO 8601 timestamp — only return comments created after this time (e.g. '2026-03-10T00:00:00Z')"),
            parentPageId: z
                .string()
                .optional()
                .describe("Optional root page ID to scope the check to a subtree (folder). " +
                "Only pages under this parent will be checked."),
        },
    }, async ({ spaceId, since, parentPageId }) => {
        // Reject an unparseable timestamp up front: otherwise the comparison
        // against NaN silently treats every comment as "not new" and the tool
        // returns zero results without signalling the bad input.
        if (Number.isNaN(Date.parse(since))) {
            throw new Error(`Invalid 'since' timestamp: ${JSON.stringify(since)} — expected an ISO 8601 date (e.g. '2026-03-10T00:00:00Z')`);
        }
        const result = await docmostClient.checkNewComments(spaceId, since, parentPageId);
        return jsonContent(result);
    });
    // Tool: search
    // INTENTIONAL per-transport divergence (not shared): the in-app `searchPages`
    // runs a semantic + keyword hybrid (RRF) with in-process access control and a
    // different schema (limit 1-20); this transport is a plain REST full-text search
    // (limit up to 100). Different behaviour AND schema, so kept per-layer.
    server.registerTool("search", {
        description: "Full-text search for pages and content across the whole workspace. " +
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
    }, async ({ query, limit }) => {
        // The tool exposes no spaceId filter, so pass undefined for the client's
        // optional spaceId parameter and forward limit into its correct slot.
        const result = await docmostClient.search(query, undefined, limit);
        return jsonContent(result);
    });
    // Tool: docmost_transform
    // INTENTIONAL per-transport divergence (not shared): the in-app `transformPage`
    // deliberately omits the `deleteComments` schema field (comment-deletion
    // guardrail) and carries a much shorter description; this transport exposes the
    // full helper catalogue. Different schema, so kept per-layer.
    server.registerTool("docmost_transform", {
        description: "Edit a page by running an arbitrary JS transform `(doc, ctx) => doc` " +
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
                .describe("A JS function `(doc, ctx) => doc` (expression-arrow or " +
                "parenthesized function). It receives a clone of the live doc and " +
                "ctx (comments, log, consume(id), helpers: blockText/walk/getList/" +
                "insertMarkerAfter/setCalloutRange/noteItem/mdToInlineNodes/" +
                "commentsToFootnotes/canonicalizeFootnotes/insertInlineFootnote) " +
                "and must return a {type:'doc'} node."),
            dryRun: z
                .boolean()
                .optional()
                .default(true)
                .describe("Preview only (no write) when true (default)."),
            deleteComments: z
                .boolean()
                .optional()
                .default(false)
                .describe("After a successful apply, delete every comment id passed to " +
                "ctx.consume(id)."),
        },
    }, async ({ pageId, transformJs, dryRun, deleteComments }) => {
        const result = await docmostClient.transformPage(pageId, transformJs, {
            dryRun,
            deleteComments,
        });
        return jsonContent(result);
    });
    // Tool: insert_footnote
    server.registerTool("insert_footnote", {
        description: "Insert an AUTHOR-INLINE footnote: you specify only WHERE (anchorText) " +
            "and WHAT (text). The footnote marker is placed right after anchorText in " +
            "the body, and the bottom footnotes list + the numbering are derived " +
            "deterministically server-side. You do NOT assign a number, and you " +
            "never see or edit the footnotes list — so footnotes cannot end up out " +
            "of order, orphaned, or as a raw '[^id]' block. If a footnote with the " +
            "SAME text already exists, its number is REUSED (one definition, several " +
            "references). The write is atomic and won't clobber concurrent edits; if " +
            "anchorText is not found, nothing is written and an error is returned.",
        inputSchema: {
            pageId: z.string().min(1),
            anchorText: z
                .string()
                .min(1)
                .describe("A snippet of existing body text; the footnote marker is inserted " +
                "immediately after its first occurrence (mark-safe)."),
            text: z
                .string()
                .min(1)
                .describe("The footnote content as markdown (becomes the definition)."),
        },
    }, async ({ pageId, anchorText, text }) => {
        const result = await docmostClient.insertFootnote(pageId, anchorText, text);
        return jsonContent(result);
    });
    // Tool: diff_page_versions
    registerShared(SHARED_TOOL_SPECS.diffPageVersions, async ({ pageId, from, to }) => {
        const result = await docmostClient.diffPageVersions(pageId, from, to);
        return jsonContent(result);
    });
    // Tool: list_page_history
    registerShared(SHARED_TOOL_SPECS.listPageHistory, async ({ pageId, cursor }) => {
        const result = await docmostClient.listPageHistory(pageId, cursor);
        return jsonContent(result);
    });
    // Tool: restore_page_version
    registerShared(SHARED_TOOL_SPECS.restorePageVersion, async ({ historyId }) => {
        const result = await docmostClient.restorePageVersion(historyId);
        return jsonContent(result);
    });
    return server;
}
