import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { DocmostClient, DocmostMcpConfig } from "./client.js";
import { parseNodeArg } from "@docmost/prosemirror-markdown";
import { SHARED_TOOL_SPECS, SharedToolSpec } from "./tool-specs.js";
import { SERVER_INSTRUCTIONS } from "./server-instructions.js";
import {
  createCommentSignalTracker,
  CommentSignalTracker,
  DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS,
} from "./comment-signal.js";

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

// Re-export the build-time REGISTRY_STAMP (issue #447): a deterministic hash of
// the tool-specs registry content, generated into src/registry-stamp.generated.ts
// by scripts/gen-registry-stamp.mjs BEFORE tsc, so it lands in build/. The in-app
// loader recomputes the same hash from src/tool-specs.ts (dev/test only) and
// refuses to run on a mismatch, catching a build/ vs src/ skew (a spec edited in
// src without rebuilding the package the server actually loads from build/).
export { REGISTRY_STAMP } from "./registry-stamp.generated.js";

// Re-export the shared "new comments: N" signal helper (#417) so the in-app
// layer reads the SAME watermark/debounce/injection-safe line builder off the
// loaded module (same pattern as SHARED_TOOL_SPECS). Both surfaces then differ
// only in their per-surface probe + result shaping.
export {
  createCommentSignalTracker,
  buildCommentSignalLine,
  defangCommentSignalTitle,
  COMMENT_SIGNAL_EXCLUDED_TOOLS,
  DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS,
} from "./comment-signal.js";
export type {
  CommentSignalTracker,
  CommentSignalProbe,
  CommentSignalProbeResult,
  CommentSignalTrackerOptions,
} from "./comment-signal.js";

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
// The guide is now SPLIT (issue #448): the hand-written routing prose lives in
// server-instructions.ts and the tool INVENTORY is GENERATED from the registry
// (SHARED_TOOL_SPECS + INLINE_MCP_INVENTORY), so it can no longer drift out of
// sync with the registered tools. Re-exported here (its old home) so existing
// importers are unaffected; the composition lives in server-instructions.ts.
// The drawio_shapes / drawio_guide tools (#424) are ordinary SHARED_TOOL_SPECS
// entries (their canonical execute calls the pure searchShapes/getGuideSection
// helpers, ignoring the client), so the registry loop registers them and the
// generated <tool_inventory> picks them up from their catalogLine automatically;
// only the hand-written routing prose in server-instructions.ts is updated to
// mention them.
export { SERVER_INSTRUCTIONS };

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

/** Resolve the per-page comment-signal debounce (ms) from the environment,
 *  falling back to the shared default. A non-positive/unparseable value keeps
 *  the default so a bad env var can never disable the rate limit. */
function resolveCommentSignalDebounceMs(): number {
  const parsed = parseInt(
    process.env.MCP_COMMENT_SIGNAL_DEBOUNCE_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_COMMENT_SIGNAL_DEBOUNCE_MS;
}

/**
 * Wrap a tool handler so a passive "new comments: N" line (#417) is APPENDED as
 * an extra text content element when the session's watermark advances. ADDITIVE
 * and non-destructive:
 *  - records the call's `pageId` (if any) into the working set;
 *  - for a comment tool (list/check/create), the result is tautological, so no
 *    signal is added and the watermark is advanced instead — the agent just
 *    consumed the feed, so those comments must not re-signal next call;
 *  - otherwise it asks the tracker for a line; when there is NONE the ORIGINAL
 *    result object is returned UNCHANGED (byte-identical no-signal path), and
 *    when there is one it returns a shallow copy with the extra text element
 *    pushed onto `content` (the main result is never mutated in place).
 * Exported so the wrapper contract can be unit-tested without a live transport.
 */
export function withCommentSignal(
  name: string,
  handler: (...args: any[]) => any,
  tracker: CommentSignalTracker,
): (...args: any[]) => Promise<any> {
  return async (...handlerArgs: any[]) => {
    const input = handlerArgs[0];
    const pageId =
      input && typeof input === "object" ? (input as any).pageId : undefined;
    tracker.noteWorkingPage(pageId);

    const result = await handler(...handlerArgs);

    if (tracker.isExcludedTool(name)) {
      tracker.advanceWatermark();
      return result;
    }
    // Only MCP text/content results can carry the extra element; anything else
    // (should not happen — every tool returns a content array) passes through.
    if (!result || !Array.isArray((result as any).content)) return result;

    const line = await tracker.maybeSignal(name);
    if (!line) return result; // no signal => byte-identical original object

    return {
      ...result,
      content: [
        ...(result as any).content,
        { type: "text" as const, text: line },
      ],
    };
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

  // Single choke point for MCP tool timing. Both `registerSharedFromSpec` (below)
  // and the inline `server.registerTool(...)` calls funnel through this one
  // method, so monkeypatching it HERE — before any tool is registered and before
  // the registry loop captures a reference to it — times every tool with no
  // per-tool boilerplate. The wrapped handler records wall-clock duration and,
  // in a `finally`, feeds the host's dependency-neutral sink
  // `config.onMetric("mcp_tool_duration_seconds", seconds, { tool })`. The tool
  // name is the registration name (bounded cardinality). When no onMetric is
  // provided (standalone/stdio) the wrapper is a pure pass-through: it still
  // returns the original result and rethrows the original error unchanged.
  // Passive "new comments: N" signal (#417). Per-SESSION state (this factory runs
  // once per MCP session — http.ts creates one server + one DocmostClient per
  // session), so the watermark/working-set/debounce live right next to the
  // client. REST-only surface => the count source (option 2) is a rate-limited
  // `listComments` over the working-set pages: the tracker guarantees at most one
  // list call per page per debounce window, and the page title is fetched ONLY
  // when there is something to report (count>0), so the steady no-signal cost is
  // a single list call per page per window and an empty working set => zero calls.
  const commentSignal = createCommentSignalTracker({
    debounceMs: resolveCommentSignalDebounceMs(),
    probe: async (pageId: string, sinceMs: number) => {
      // Full feed (incl. resolved) so a human's comment on any thread is seen;
      // count only those created strictly after the watermark.
      const { items } = await docmostClient.listComments(pageId, true);
      const count = (items as any[]).filter((c) => {
        const created = c && c.createdAt ? new Date(c.createdAt).getTime() : NaN;
        return Number.isFinite(created) && created > sinceMs;
      }).length;
      let title: string | undefined;
      if (count > 0) {
        // Title labels the signal; untrusted, defanged by the shared builder.
        // Fetched only on a hit, so the no-signal path never pays for it.
        try {
          const page: any = await docmostClient.getPageRaw(pageId);
          title = page?.title ?? undefined;
        } catch {
          // Title is optional — omit it if the page can't be fetched.
        }
      }
      return { count, title };
    },
  });

  // Single choke point again: the timing monkeypatch (above) and the new comment
  // signal wrapper both funnel through server.registerTool, so wrapping HERE adds
  // the passive signal to EVERY tool result with no per-tool boilerplate. The
  // signal wrapper is OUTERMOST (it wraps the timed handler) so the probe latency
  // is never counted as the tool's own `mcp_tool_duration_seconds`.
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: any[]
  ) => any;
  (server as any).registerTool = (...args: any[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1];
    const timedHandler = timeToolHandler(name, handler, config.onMetric);
    const signalledHandler = withCommentSignal(name, timedHandler, commentSignal);
    return originalRegisterTool(...args.slice(0, -1), signalledHandler);
  };

  // Register EVERY shared tool from the zod-agnostic registry in one loop (#445).
  // The spec owns the canonical name + description + (optional) schema builder AND
  // the canonical execute mapping; the host only supplies the RESULT ENVELOPE. For
  // each spec:
  //   - skip `inAppOnly` specs (they belong to the in-app host only);
  //   - if the spec has an `mcpExecute` override (a deliberate per-layer
  //     difference — a guardrail, an omitted param, or a non-JSON envelope like a
  //     resource_link/bare success line), the override OWNS the full MCP content
  //     result and is used VERBATIM;
  //   - otherwise the canonical `execute` returns RAW data and this host wraps it
  //     in the standard JSON text envelope (jsonContent), exactly as the old inline
  //     bodies did.
  // buildShape is invoked with THIS package's zod (v3); the in-app layer passes its
  // own zod (v4). The registry's execute returns `unknown` (it is zod-agnostic), so
  // the wrapping is typed loosely and cast — runtime behaviour is unchanged.
  const registerSharedFromSpec = (spec: SharedToolSpec) => {
    if (spec.inAppOnly) return;
    const handler = async (args: any) => {
      if (spec.mcpExecute) {
        // The override owns the full MCP result envelope (not re-wrapped).
        return (await spec.mcpExecute(docmostClient, args)) as {
          content: { type: "text"; text: string }[];
        };
      }
      // Canonical execute returns raw data; wrap it as JSON text content.
      const raw = await spec.execute!(docmostClient, args);
      return jsonContent(raw);
    };
    return (server.registerTool as any)(
      spec.mcpName,
      spec.buildShape
        ? { description: spec.description, inputSchema: spec.buildShape(z) }
        : { description: spec.description },
      handler,
    );
  };

  for (const spec of Object.values(SHARED_TOOL_SPECS)) {
    registerSharedFromSpec(spec as SharedToolSpec);
  }

  // --- INLINE tools kept per-transport (NOT in the shared registry) ---
  // Each stays inline for a documented reason: a snake_case/camelCase naming
  // clash the registry convention forbids (table_get), an intentional
  // per-transport behaviour/schema divergence (search, docmost_transform), or a
  // tool that exists ONLY on this standalone MCP surface (update_comment,
  // delete_comment — the in-app agent deliberately exposes no hard comment
  // edit/delete tool).

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

  return server;
}
