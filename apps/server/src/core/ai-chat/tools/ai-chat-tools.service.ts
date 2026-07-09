import { Injectable, Logger } from '@nestjs/common';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { User } from '@docmost/db/types/entity.types';
import { TokenService } from '../../auth/services/token.service';
import { AiService } from '../../../integrations/ai/ai.service';
import { AiEmbeddingNotConfiguredException } from '../../../integrations/ai/ai-embedding-not-configured.exception';
import { PageEmbeddingRepo } from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { SpaceMemberRepo } from '@docmost/db/repos/space/space-member.repo';
import { PagePermissionRepo } from '@docmost/db/repos/page/page-permission.repo';
import {
  loadDocmostMcp,
  type DocmostClientLike,
  type SharedToolSpec,
} from './docmost-client.loader';
import {
  resolveCurrentPageResult,
  type SelectionContext,
} from './current-page.util';
import { parseNodeArg } from '@docmost/prosemirror-markdown';
import { modelFriendlyInput } from './model-friendly-input';
import { SandboxStore } from '../../../integrations/sandbox/sandbox.store';
import {
  buildInAppDeferredCatalog,
  type ToolCatalogEntry,
} from './tool-tiers';

/**
 * Per-user, per-request adapter that exposes Docmost READ operations to the
 * agent as AI SDK tools (STAGE A = read only).
 *
 * Each tool call goes loopback over the user's own access JWT, so Docmost CASL
 * enforces access on every request — there is NO extra authorization here
 * (§8.5). The client is built fresh per chat request and never shares the
 * cached service-account `/mcp` handler.
 *
 * SINGLE-WORKSPACE ASSUMPTION: the loopback host (127.0.0.1) does not resolve a
 * workspace subdomain, so this targets the default/first workspace only. The
 * existing service-account `/mcp` path already calls loopback successfully, so
 * this works for single-workspace self-host.
 */
@Injectable()
export class AiChatToolsService {
  private readonly logger = new Logger(AiChatToolsService.name);

  constructor(
    private readonly tokenService: TokenService,
    private readonly aiService: AiService,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly spaceMemberRepo: SpaceMemberRepo,
    private readonly pagePermissionRepo: PagePermissionRepo,
    // Shared singleton in-RAM blob store backing the stash tool.
    private readonly sandboxStore: SandboxStore,
  ) {}

  /**
   * Construct the per-user loopback `DocmostClient` used to reach Docmost's REST
   * / collab surface AS the current user. Every call is scoped by the user's own
   * access JWT (CASL-enforced) and carries the signed agent provenance claim
   * ({ actor:'agent', aiChatId }) for both the access and collab tokens. Shared
   * by `forUser` (the agent toolset) and `exportPageMarkdown` (the #274
   * page-change detection path) so they use an identical authenticated route.
   */
  private async buildDocmostClient(
    user: User,
    sessionId: string,
    workspaceId: string,
    aiChatId: string,
  ): Promise<DocmostClientLike> {
    const apiUrl =
      process.env.MCP_DOCMOST_API_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/api`;

    // BARE access JWT carrying the agent provenance claim (the client adds the
    // "Bearer " prefix and re-calls this on a 401). Minted against the live
    // session so jwt.strategy validates it (§15[C1]); the signed actor/aiChatId
    // drives the REST write provenance (create/rename/move page, comment
    // create/resolve) server-side.
    const getToken = () =>
      this.tokenService.generateAccessToken(user, sessionId, {
        actor: 'agent',
        aiChatId,
      });

    // Provenance COLLAB token for content mutations (which go over the collab
    // websocket). Signed with the same agent claim so onAuthenticate ->
    // onStoreDocument record 'agent'/aiChatId on the page (§6.6/§15 C2). The
    // client routes every content mutation through this provider instead of
    // POST /auth/collab-token.
    const getCollabToken = () =>
      this.tokenService.generateCollabToken(user, workspaceId, {
        actor: 'agent',
        aiChatId,
      });

    // Bind the stash tool to the shared in-RAM SandboxStore. The store owns the
    // anonymous-URL composition (putAndLink) and the live/evict probes the MCP
    // package needs to keep its mirror counts honest under FIFO eviction (the
    // package never touches env or the store). asSink() centralizes the uri↔id
    // mapping next to putAndLink, shared with the embedded-MCP wiring site.
    const { DocmostClient } = await loadDocmostMcp();
    return new DocmostClient({
      apiUrl,
      getToken,
      getCollabToken,
      sandbox: this.sandboxStore.asSink(),
    });
  }

  /**
   * Export a page's current Markdown (meta + body + comment threads) via the
   * SAME loopback path the `exportPageMarkdown` tool uses (#274). Used by the
   * per-turn page-change detection to render both the snapshot end and the
   * current end identically, so formatting never pollutes the diff. Access is
   * CASL-enforced by the user's JWT: a page the user cannot read throws.
   */
  async exportPageMarkdown(
    user: User,
    sessionId: string,
    workspaceId: string,
    aiChatId: string,
    pageId: string,
  ): Promise<string> {
    const client = await this.buildDocmostClient(
      user,
      sessionId,
      workspaceId,
      aiChatId,
    );
    return client.exportPageMarkdown(pageId);
  }

  /**
   * Build the IN-APP deferred <tool_catalog> entries (#332): one "name — purpose"
   * line per DEFERRED tool, merging the per-layer INLINE_TOOL_TIERS with the
   * shared registry's own catalogLine. Loads @docmost/mcp for the shared specs
   * (memoized). Core tools are always active and are NOT listed here. External
   * MCP tools are catalogued separately by the caller (they are runtime-scoped).
   */
  async getInAppDeferredCatalog(): Promise<ToolCatalogEntry[]> {
    const { sharedToolSpecs } = await loadDocmostMcp();
    return buildInAppDeferredCatalog(sharedToolSpecs);
  }

  async forUser(
    user: User,
    sessionId: string,
    // workspaceId scopes the provenance collab token (which is workspace-bound),
    // and documents the single-workspace assumption; the loopback REST client is
    // scoped by the user's JWT, not by an explicit workspace argument.
    workspaceId: string,
    // The resolved AI chat id. Threaded into both provenance tokens so every
    // agent write (REST + collab) records { actor:'agent', aiChatId } off a
    // SIGNED claim — non-spoofable, never a client body field (§6.5/§6.6).
    aiChatId: string,
    // The page the user currently has open (from the request context), exposed
    // to the model via getCurrentPage. Optional and last so existing callers
    // keep compiling. Kept proxy-robust: the model can CALL for the current
    // page instead of relying on it surviving in the system prompt text. The
    // `selection` (#388) is already sanitized + nested by resolveOpenPageContext.
    openedPage?: {
      id?: string;
      title?: string;
      selection?: SelectionContext | null;
    } | null,
  ): Promise<Record<string, Tool>> {
    // Build the per-user loopback client (carrying the access + collab
    // provenance tokens) and load the shared tool-spec registry. Client
    // construction is shared with the page-change detection path (#274) via
    // buildDocmostClient so both go over the exact same authenticated route.
    const { sharedToolSpecs } = await loadDocmostMcp();
    const client = await this.buildDocmostClient(
      user,
      sessionId,
      workspaceId,
      aiChatId,
    );

    // Build an ai-SDK tool from a shared, zod-agnostic spec. The spec owns the
    // canonical description + (optional) schema builder, which is invoked with
    // THIS layer's zod (v4); only the execute body is supplied per call. No-arg
    // specs (no buildShape) get an empty object schema.
    const sharedTool = (
      spec: SharedToolSpec,
      execute: Tool['execute'],
    ): Tool =>
      tool({
        description: spec.description,
        // Wrap via modelFriendlyInput so a dropped/invalid parameter (e.g. a
        // pageId omitted in a parallel batch, #190) yields a clear, actionable
        // tool error instead of zod's raw text. No-arg specs still get an empty
        // object schema.
        inputSchema: modelFriendlyInput(
          spec.buildShape ? (spec.buildShape(z) as z.ZodRawShape) : {},
        ),
        execute,
      });

    return {
      // INTENTIONAL per-transport divergence (not in the shared registry): this
      // in-app search runs a semantic + keyword hybrid (RRF) with in-process
      // access control and a tuned schema (limit 1-20); the standalone MCP
      // `search` is a plain REST full-text search (limit up to 100). Different
      // behaviour AND schema, so kept per-layer.
      searchPages: tool({
        description:
          'Search the wiki for pages relevant to a query. Combines exact ' +
          'keyword/identifier matching with semantic meaning and returns the ' +
          'most relevant pages with a short snippet, best match first. ' +
          "Rephrase the user's question into a focused search query (key terms " +
          'and entities), not a full sentence. If the first results look weak ' +
          'or incomplete, search again with different wording or synonyms ' +
          'before answering.',
        inputSchema: modelFriendlyInput({
          query: z.string().describe('The search query.'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe('Maximum number of results (1-20).'),
        }),
        execute: async ({ query, limit }) => {
          const trimmed = (query ?? '').trim();
          if (!trimmed) return [];

          const cap = limit ?? 10;

          // Loopback REST full-text fallback. Used when AI search is not
          // configured, embedding fails, there are no accessible spaces, or the
          // hybrid query returns nothing — so keyword search always works.
          const fallback = async () => {
            // search(query, spaceId?, limit?) -> { items, success }.
            // Items are filterSearchResult(): { id, title, highlight, ... }.
            const result = await client.search(trimmed, undefined, cap);
            const items = Array.isArray(result?.items) ? result.items : [];
            // Keep the payload token-efficient: id + title + a short snippet.
            return items.map((raw) => {
              const item = raw as {
                id?: string;
                slugId?: string;
                title?: string;
                highlight?: string;
              };
              return {
                id: item.id ?? item.slugId,
                title: item.title ?? '',
                snippet: snippet(item.highlight),
              };
            });
          };

          // HYBRID path: fuse semantic (vector) + lexical (full-text) rankings
          // via RRF. Over-fetch candidates so the page-permission post-filter
          // still leaves enough results.
          const candidates = Math.min(Math.max(cap * 5, 50), 200);

          // 1) Embed the query. Unconfigured embeddings (or any embedding error)
          //    routes to the REST full-text fallback instead of erroring.
          let queryVector: number[];
          try {
            const [vec] = await this.aiService.embedTexts(workspaceId, [
              trimmed,
            ]);
            if (!vec) return await fallback();
            queryVector = vec;
          } catch (err) {
            if (!(err instanceof AiEmbeddingNotConfiguredException)) {
              // Never leak provider/key details; log generically and fall back.
              this.logger.warn(
                `searchPages embed failed: ${
                  err instanceof Error ? err.message : 'unknown error'
                }`,
              );
            }
            return await fallback();
          }

          // 2) ACCESS CONTROL: the hybrid query runs IN-PROCESS (a direct
          //    pgvector + full-text query), so unlike the loopback REST tools it
          //    does NOT get CASL for free. Scope to the spaces the user can read
          //    (member spaces + groups), mirroring SearchService.searchPage. No
          //    accessible spaces => fall back to REST (which is CASL-scoped).
          const accessibleSpaceIds =
            await this.spaceMemberRepo.getUserSpaceIds(user.id);
          if (accessibleSpaceIds.length === 0) return await fallback();

          // 3) Hybrid RRF retrieval, scoped to the workspace AND accessible
          //    spaces.
          const hits = await this.pageEmbeddingRepo.hybridSearch(
            workspaceId,
            queryVector,
            trimmed,
            accessibleSpaceIds,
            candidates,
          );
          if (hits.length === 0) return await fallback();

          // 4) Page-level permission post-filter: an accessible space does not
          //    imply every page in it is accessible (restricted pages). Mirror
          //    SearchService.searchPage's filterAccessiblePageIds pass.
          const pageIds = Array.from(new Set(hits.map((h) => h.pageId)));
          const accessibleIds =
            await this.pagePermissionRepo.filterAccessiblePageIds({
              pageIds,
              userId: user.id,
            });
          const accessibleSet = new Set(accessibleIds);

          // Keep the best (first — hits are ordered by fused score desc) chunk
          // per page, dropping any page the user cannot access, capped to `cap`.
          return selectAccessibleHits(hits, accessibleSet, cap);
        },
      }),

      getCurrentPage: tool({
        description:
          'Return the page the user is currently viewing — i.e. what "this page", ' +
          '"the current page", or "here" refers to — plus the text the user ' +
          'currently has SELECTED on that page (what "this", "here", "the selected ' +
          'fragment" refers to), or selection: null when nothing is selected. The ' +
          'selection is a client-side snapshot taken when the user sent the message ' +
          'and includes the ids of the blocks it covers plus surrounding context; ' +
          'it is NOT verified server-side — locate it in the page (searchInPage / ' +
          'getNode) before editing. Returns page: null if the user is not currently ' +
          'on a page. Call this first whenever the user refers to the current page ' +
          'or a selected fragment without giving an explicit id.',
        inputSchema: modelFriendlyInput({}),
        execute: async () => resolveCurrentPageResult(openedPage),
      }),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      // The execute body keeps this layer's { title, markdown } projection.
      getPage: sharedTool(sharedToolSpecs.getPage, async ({ pageId }) => {
        // getPage(pageId) -> { data: filterPage(page, markdown), success }.
        const result = await client.getPage(pageId);
        const data = (result?.data ?? {}) as {
          title?: string;
          content?: string;
        };
        return {
          title: data.title ?? '',
          markdown: typeof data.content === 'string' ? data.content : '',
        };
      }),

      // --- WRITE tools (all reversible — history/trash; §6.5 / D3) ---

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      createPage: sharedTool(
        sharedToolSpecs.createPage,
        async ({ title, content, spaceId, parentPageId }) => {
          // createPage(title, content, spaceId, parentPageId?) ->
          // { data: filterPage(page, markdown), success }.
          const result = await client.createPage(
            title,
            content ?? '',
            spaceId,
            parentPageId,
          );
          const data = (result?.data ?? {}) as {
            id?: string;
            slugId?: string;
            title?: string;
          };
          return { id: data.id ?? data.slugId, title: data.title ?? title };
        },
      ),

      updatePageContent: tool({
        description:
          "Replace a page's body with new Markdown content (and optionally its " +
          'title). Reversible: the previous version is kept in page history.',
        inputSchema: modelFriendlyInput({
          pageId: z.string().describe('The id of the page to update.'),
          content: z.string().describe('The new page body as Markdown.'),
          title: z
            .string()
            .optional()
            .describe('Optional new title for the page.'),
        }),
        execute: async ({ pageId, content, title }) => {
          // updatePage mutates the live collab doc -> provenance flows from the
          // collab-token provider. Returns { success, modified, message, pageId }.
          const result = (await client.updatePage(pageId, content, title)) as {
            success?: boolean;
          };
          return { pageId, updated: result?.success ?? true };
        },
      }),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      renamePage: sharedTool(
        sharedToolSpecs.renamePage,
        async ({ pageId, title }) => {
          // renamePage(pageId, title) -> { success, pageId, title }.
          await client.renamePage(pageId, title);
          return { pageId, title };
        },
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      // The shared schema adds the optional `position` field this layer lacked
      // before; the execute now forwards it (the client already accepted it).
      movePage: sharedTool(
        sharedToolSpecs.movePage,
        async ({ pageId, parentPageId, position }) => {
          // movePage(pageId, parentPageId, position?) -> raw move response.
          await client.movePage(pageId, parentPageId ?? null, position);
          return { pageId, parentPageId: parentPageId ?? null, moved: true };
        },
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      // GUARDRAIL (§14 H4) preserved: the shared schema exposes ONLY pageId, so
      // permanentlyDelete/forceDelete are never part of the input and can never
      // be forwarded — the agent physically cannot permanently delete a page.
      deletePage: sharedTool(sharedToolSpecs.deletePage, async ({ pageId }) => {
        // deletePage(pageId) hits POST /pages/delete with { pageId } only,
        // which is the soft-delete (trash) path on the server.
        await client.deletePage(pageId);
        return { pageId, trashed: true };
      }),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      // This layer keeps only its own execute-side guards (require a selection
      // for a top-level comment; reject suggestedText on a reply / without a
      // selection) — the schema+description are shared.
      createComment: sharedTool(
        sharedToolSpecs.createComment,
        async ({
          pageId,
          content,
          selection,
          parentCommentId,
          suggestedText,
        }) => {
          // createComment(pageId, content, type, selection?, parentCommentId?,
          // suggestedText?). Top-level comments are inline and must carry a
          // selection to anchor on; replies inherit the parent's anchor (no
          // selection). Throwing here surfaces a tool error to the model (Vercel
          // `ai` SDK) so the agent retries with a better selection — do not
          // catch/suppress it.
          if (!parentCommentId && (!selection || !selection.trim())) {
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
            if (!selection || !selection.trim()) {
              throw new Error(
                "createComment: 'suggestedText' requires a 'selection' to anchor and rewrite.",
              );
            }
          }
          const result = await client.createComment(
            pageId,
            content,
            'inline',
            selection,
            parentCommentId,
            suggestedText,
          );
          const data = (result?.data ?? {}) as { id?: string };
          return { commentId: data.id, pageId };
        },
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      resolveComment: sharedTool(
        sharedToolSpecs.resolveComment,
        async ({ commentId, resolved }) => {
          // resolveComment(commentId, resolved) -> { success, commentId, resolved }.
          await client.resolveComment(commentId, resolved);
          return { commentId, resolved };
        },
      ),

      // --- READ tools (added) ---

      getWorkspace: sharedTool(
        sharedToolSpecs.getWorkspace,
        async () => await client.getWorkspace(),
      ),

      listSpaces: sharedTool(
        sharedToolSpecs.listSpaces,
        async () => await client.getSpaces(),
      ),

      // INTENTIONAL per-transport divergence (not shared): keeps the `tree:true`
      // hierarchy mode but is worded for the in-app agent; the standalone MCP
      // `list_pages` carries its own wording. Kept per-layer so each side tunes
      // its own guidance.
      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      listPages: sharedTool(
        sharedToolSpecs.listPages,
        async ({ spaceId, limit, tree }) =>
          await client.listPages(spaceId, limit, tree),
      ),

      listSidebarPages: tool({
        description:
          'List sidebar pages for a space. With no pageId, returns the ' +
          "space's ROOT pages; with a pageId, returns that page's direct " +
          'CHILDREN.',
        inputSchema: modelFriendlyInput({
          spaceId: z.string().describe('The id of the space.'),
          pageId: z
            .string()
            .optional()
            .describe(
              'Optional page id; when given, lists that page\'s direct children.',
            ),
        }),
        execute: async ({ spaceId, pageId }) =>
          await client.listSidebarPages(spaceId, pageId),
      }),

      getOutline: sharedTool(
        sharedToolSpecs.getOutline,
        async ({ pageId }) => await client.getOutline(pageId),
      ),

      getPageJson: sharedTool(
        sharedToolSpecs.getPageJson,
        async ({ pageId }) => await client.getPageJson(pageId),
      ),

      getNode: sharedTool(
        sharedToolSpecs.getNode,
        async ({ pageId, nodeId }) => await client.getNode(pageId, nodeId),
      ),

      searchInPage: sharedTool(
        sharedToolSpecs.searchInPage,
        async ({ pageId, query, regex, caseSensitive, limit }) =>
          await client.searchInPage(pageId, query, {
            regex,
            caseSensitive,
            limit,
          }),
      ),

      // NOT shared (kept inline): the MCP tool name `table_get` is noun-first
      // while this key is `getTable` (verb-first), breaking the
      // snake_case(inAppKey) convention the shared registry enforces. Its
      // reference parameter is still named `table` (was `tableRef`) so it matches
      // the migrated table row/cell tools below.
      getTable: tool({
        description:
          'Read a table as a matrix of cell texts (plus a parallel cellIds ' +
          'matrix so cells can be addressed for rich edits).',
        inputSchema: modelFriendlyInput({
          pageId: z.string().describe('The id of the page.'),
          table: z
            .string()
            .describe(
              '"#<index>" from the page outline, or a block id of any node ' +
                'inside the table.',
            ),
        }),
        execute: async ({ pageId, table }) =>
          await client.getTable(pageId, table),
      }),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      listComments: sharedTool(
        sharedToolSpecs.listComments,
        async ({ pageId, includeResolved }) =>
          await client.listComments(pageId, includeResolved),
      ),

      getComment: tool({
        description: 'Fetch a single comment by id (content as Markdown).',
        inputSchema: modelFriendlyInput({
          commentId: z.string().describe('The id of the comment.'),
        }),
        execute: async ({ commentId }) => await client.getComment(commentId),
      }),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      checkNewComments: sharedTool(
        sharedToolSpecs.checkNewComments,
        async ({ spaceId, since, parentPageId }) =>
          await client.checkNewComments(spaceId, since, parentPageId),
      ),

      listShares: sharedTool(
        sharedToolSpecs.listShares,
        async () => await client.listShares(),
      ),

      listPageHistory: sharedTool(
        sharedToolSpecs.listPageHistory,
        async ({ pageId, cursor }) =>
          await client.listPageHistory(pageId, cursor),
      ),

      getPageHistory: tool({
        description:
          'Fetch a single page-history version including its lossless ' +
          'ProseMirror content.',
        inputSchema: modelFriendlyInput({
          historyId: z.string().describe('The id of the history version.'),
        }),
        execute: async ({ historyId }) =>
          await client.getPageHistory(historyId),
      }),

      diffPageVersions: sharedTool(
        sharedToolSpecs.diffPageVersions,
        async ({ pageId, from, to }) =>
          await client.diffPageVersions(pageId, from, to),
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      exportPageMarkdown: sharedTool(
        sharedToolSpecs.exportPageMarkdown,
        async ({ pageId }) => {
          const markdown = await client.exportPageMarkdown(pageId);
          return { markdown };
        },
      ),

      // --- WRITE tools (added; reversible via page history/trash) ---

      editPageText: sharedTool(
        sharedToolSpecs.editPageText,
        async ({ pageId, edits }) => await client.editPageText(pageId, edits),
      ),

      // Returns ONLY the short link object — never the document body — so a
      // large page can be handed to an external consumer without bloating
      // context.
      stashPage: sharedTool(
        sharedToolSpecs.stashPage,
        async ({ pageId }) => await client.stashPage(pageId),
      ),

      // Schema + description from the shared registry (identical across both
      // transports). The execute body keeps its OWN parseNodeArg normalization:
      // the model sometimes serializes the node as a JSON string, and we parse it
      // before the client's typeof-object guard rejects it (parity with the
      // standalone MCP server, index.ts patch_node).
      patchNode: sharedTool(
        sharedToolSpecs.patchNode,
        async ({ pageId, nodeId, node }) => {
          const parsedNode = parseNodeArg(node);
          return await client.patchNode(pageId, nodeId, parsedNode);
        },
      ),

      // Shared registry schema + description; execute retains parseNodeArg on the
      // incoming node (parity with the standalone MCP server, index.ts
      // insert_node).
      insertNode: sharedTool(
        sharedToolSpecs.insertNode,
        async ({ pageId, node, position, anchorNodeId, anchorText }) => {
          const parsedNode = parseNodeArg(node);
          return await client.insertNode(pageId, parsedNode, {
            position,
            anchorNodeId,
            anchorText,
          });
        },
      ),

      deleteNode: sharedTool(
        sharedToolSpecs.deleteNode,
        async ({ pageId, nodeId }) => await client.deleteNode(pageId, nodeId),
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      // The execute body keeps this layer's content normalization (parity with
      // the standalone MCP server, index.ts update_page_json).
      updatePageJson: sharedTool(
        sharedToolSpecs.updatePageJson,
        async ({ pageId, content, title }) => {
          // undefined/null pass through as undefined (title-only / no-op); any
          // string is JSON.parsed (so an empty string "" throws, matching the
          // MCP server); an object is passed through unchanged.
          let doc;
          if (content === undefined || content === null) {
            doc = undefined;
          } else {
            // String -> JSON.parse (throwing on invalid); object passes through.
            doc = parseNodeArg(content, 'content was a string but not valid JSON');
          }
          return await client.updatePageJson(pageId, doc, title);
        },
      ),

      // Schema + description live in @docmost/mcp's SHARED_TOOL_SPECS (#410).
      // Promoted from MCP-only so the in-app agent can attach a REAL footnote to
      // already-written text instead of leaving a literal `^[...]` string.
      insertFootnote: sharedTool(
        sharedToolSpecs.insertFootnote,
        async ({ pageId, anchorText, text }) =>
          await client.insertFootnote(pageId, anchorText, text),
      ),

      // Schema + description live in @docmost/mcp's SHARED_TOOL_SPECS (#410).
      // The schema field is `imageUrl`; the client method takes it positionally.
      insertImage: sharedTool(
        sharedToolSpecs.insertImage,
        async ({ pageId, imageUrl, align, alt, replaceText, afterText }) =>
          await client.insertImage(pageId, imageUrl, {
            align,
            alt,
            replaceText,
            afterText,
          }),
      ),

      // Schema + description live in @docmost/mcp's SHARED_TOOL_SPECS (#410).
      replaceImage: sharedTool(
        sharedToolSpecs.replaceImage,
        async ({ pageId, attachmentId, imageUrl, align, alt }) =>
          await client.replaceImage(pageId, attachmentId, imageUrl, {
            align,
            alt,
          }),
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      // The table reference parameter was unified to `table` (was `tableRef`).
      tableInsertRow: sharedTool(
        sharedToolSpecs.tableInsertRow,
        async ({ pageId, table, cells, index }) =>
          await client.tableInsertRow(pageId, table, cells, index),
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      tableDeleteRow: sharedTool(
        sharedToolSpecs.tableDeleteRow,
        async ({ pageId, table, index }) =>
          await client.tableDeleteRow(pageId, table, index),
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      tableUpdateCell: sharedTool(
        sharedToolSpecs.tableUpdateCell,
        async ({ pageId, table, row, col, text }) =>
          await client.tableUpdateCell(pageId, table, row, col, text),
      ),

      copyPageContent: sharedTool(
        sharedToolSpecs.copyPageContent,
        async ({ sourcePageId, targetPageId }) =>
          await client.copyPageContent(sourcePageId, targetPageId),
      ),

      importPageMarkdown: sharedTool(
        sharedToolSpecs.importPageMarkdown,
        async ({ pageId, markdown }) =>
          await client.importPageMarkdown(pageId, markdown),
      ),

      // Schema + description now live in @docmost/mcp's SHARED_TOOL_SPECS (#294).
      // Both layers already carried the security-confirmation framing, so there
      // was no real divergence to preserve — only wording drift.
      sharePage: sharedTool(
        sharedToolSpecs.sharePage,
        async ({ pageId, searchIndexing }) =>
          await client.sharePage(pageId, searchIndexing),
      ),

      unsharePage: sharedTool(
        sharedToolSpecs.unsharePage,
        async ({ pageId }) => await client.unsharePage(pageId),
      ),

      restorePageVersion: sharedTool(
        sharedToolSpecs.restorePageVersion,
        async ({ historyId }) => await client.restorePageVersion(historyId),
      ),

      // INTENTIONAL per-transport divergence (not shared): deliberately omits the
      // `deleteComments` schema field (comment-deletion guardrail) and carries a
      // much shorter description; the standalone MCP `docmost_transform` exposes
      // the full helper catalogue. Different schema, so kept per-layer.
      transformPage: tool({
        description:
          'Run a sandboxed JS transform of the form `(doc, ctx) => doc` over a ' +
          "page's ProseMirror document for complex/scripted rewrites. dryRun " +
          '(default true) previews a diff WITHOUT writing; set dryRun:false to ' +
          'apply. Reversible: applying creates a new page-history snapshot.',
        inputSchema: modelFriendlyInput({
          pageId: z.string().describe('The id of the page to transform.'),
          transformJs: z
            .string()
            .describe('The JS transform body: `(doc, ctx) => doc`.'),
          dryRun: z
            .boolean()
            .optional()
            .describe('Preview the diff without writing (default true).'),
        }),
        // GUARDRAIL: the schema deliberately omits `deleteComments`, and the
        // execute below NEVER passes it, so the client's comment-deletion path
        // stays unreachable from the agent.
        execute: async ({ pageId, transformJs, dryRun }) =>
          await client.transformPage(pageId, transformJs, { dryRun }),
      }),
    };
  }
}

/** A single hybrid-search hit: the minimal shape selectAccessibleHits needs. */
export interface SearchHitLike {
  pageId: string;
  title: string | null;
  content: string;
}

/**
 * Post-filter hybrid-search hits into the agent-facing result list. This is the
 * CASL leak guard for the in-process hybrid search: the hits come from a direct
 * pgvector + full-text query that does NOT get CASL for free, so an accessible
 * SPACE does not imply every page in it is accessible (restricted pages).
 *
 * Given `hits` (ordered by fused score desc), the `accessibleSet` of page ids
 * the user may read, and `cap`, it keeps the BEST (first) chunk per page, drops
 * any page not in `accessibleSet`, and caps the output at `cap`. Pure — no I/O.
 */
export function selectAccessibleHits(
  hits: readonly SearchHitLike[],
  accessibleSet: Set<string>,
  cap: number,
): { id: string; title: string; snippet: string }[] {
  const seen = new Set<string>();
  const results: { id: string; title: string; snippet: string }[] = [];
  for (const hit of hits) {
    if (!accessibleSet.has(hit.pageId)) continue;
    if (seen.has(hit.pageId)) continue;
    seen.add(hit.pageId);
    results.push({
      id: hit.pageId,
      title: hit.title ?? '',
      snippet: snippet(hit.content),
    });
    if (results.length >= cap) break;
  }
  return results;
}

/**
 * Trim a search highlight/snippet to a token-efficient length. The highlight
 * may contain `<b>` markers from the search backend; they are harmless to the
 * model but we cap the overall length so a long page does not bloat the tool
 * result.
 */
function snippet(text: string | undefined): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  const MAX = 300;
  return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
}
