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
  type CommentSignalTrackerLike,
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
 * Compile-time contract (issue #446): the in-app tool `execute` closures below
 * call the loopback `DocmostClient` POSITIONALLY (e.g.
 * `client.drawioGet(pageId, node, format ?? 'xml')`). Those closures receive an
 * AI-SDK-erased (`any`) input, so a positional call inside them is NOT checked
 * against the real signature — a parameter reorder/type-change in
 * `packages/mcp/src/client.ts` would otherwise reach production as a runtime
 * "wrong argument" tool failure with zero compile signal (the restored #294
 * debt). This never-called function reproduces every positional call with
 * correctly-typed placeholder arguments against the DERIVED `DocmostClientLike`
 * (a `Pick` of the real `DocmostClient`), so any such reorder/rename becomes a
 * SERVER COMPILE ERROR here. It emits nothing (types only) and is never invoked;
 * keep each call in lockstep with the matching `execute` body below.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function __assertClientCallContract(client: DocmostClientLike): void {
  // Placeholders standing in for the AI-SDK-erased execute inputs. Their types
  // are deliberately concrete so the positional calls are checked end-to-end.
  const s = '' as string;
  const n = 0 as number;
  const node: unknown = null;
  const edits: Array<{ find: string; replace: string; replaceAll?: boolean }> =
    [];
  const cells: string[] = [];
  const align = undefined as 'left' | 'center' | 'right' | undefined;

  // --- read ---
  void client.search(s, undefined, n);
  void client.getPage(s);
  void client.getPageRaw(s);
  void client.getWorkspace();
  void client.getSpaces();
  void client.listPages(s, n, true);
  void client.listSidebarPages(s, s);
  void client.getOutline(s);
  void client.getPageJson(s);
  void client.getNode(s, s);
  void client.searchInPage(s, s, {
    regex: true,
    caseSensitive: true,
    limit: n,
  });
  void client.getTable(s, s);
  void client.listComments(s, true);
  void client.getComment(s);
  void client.checkNewComments(s, s, s);
  void client.listShares();
  void client.listPageHistory(s, s);
  void client.getPageHistory(s);
  void client.diffPageVersions(s, s, s);
  void client.exportPageMarkdown(s);
  // --- write (page) ---
  void client.createPage(s, s, s, s);
  void client.updatePage(s, s, s);
  void client.renamePage(s, s);
  void client.movePage(s, s, s);
  void client.deletePage(s);
  void client.editPageText(s, edits);
  void client.patchNode(s, s, node);
  void client.insertNode(s, node, {
    position: 'append',
    anchorNodeId: s,
    anchorText: s,
  });
  void client.deleteNode(s, s);
  void client.updatePageJson(s, node, s);
  void client.tableInsertRow(s, s, cells, n);
  void client.tableDeleteRow(s, s, n);
  void client.tableUpdateCell(s, s, n, n, s);
  void client.copyPageContent(s, s);
  void client.importPageMarkdown(s, s);
  void client.sharePage(s, true);
  void client.unsharePage(s);
  void client.restorePageVersion(s);
  void client.transformPage(s, s, { dryRun: true });
  void client.stashPage(s);
  // --- write (image / footnote), in-app since #410 ---
  void client.insertFootnote(s, s, s);
  void client.insertImage(s, s, {
    align,
    alt: s,
    replaceText: s,
    afterText: s,
  });
  void client.replaceImage(s, s, s, { align, alt: s });
  // --- draw.io diagrams (#423 stage 1, #424 stage 2) ---
  // The 5th `layout` arg (#424) is exercised so this parity assertion fails if the
  // client signature drops it — it must reach the client from the shared execute.
  void client.drawioGet(s, s, 'xml');
  void client.drawioCreate(s, { position: 'append', anchorNodeId: s }, s, s, 'elk');
  void client.drawioUpdate(s, s, s, s, 'elk');
  // --- write (comment) ---
  void client.createComment(s, s, 'inline', s, s, s);
  void client.resolveComment(s, true);
}

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
    // drawio_shapes / drawio_guide (#424) are NOT destructured here anymore: they
    // are ordinary SHARED_TOOL_SPECS entries whose canonical execute (in the mcp
    // package) calls the pure searchShapes / getGuideSection helpers directly, so
    // the registry loop below wires them for the in-app host too — no hand-mirrored
    // handler and no direct helper import in this service.
    const { sharedToolSpecs, createCommentSignalTracker } =
      await loadDocmostMcp();
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

    // The in-app toolset. It starts with the tools kept INLINE here for a
    // documented per-layer reason: an intentional behaviour/schema divergence from
    // the standalone MCP surface (searchPages' hybrid RRF, updatePageContent's
    // Markdown write, transformPage's guardrailed shorter schema), a
    // snake_case/camelCase naming clash the shared registry forbids (getTable vs
    // the MCP `table_get`), per-request state the registry loop cannot provide
    // (getCurrentPage reads the resolved openedPage; searchPages closes over the
    // per-request user/embedding deps), or a tool with no MCP twin
    // (listSidebarPages/getComment/getPageHistory). Every SHARED tool is then added
    // by the registry loop below (see it), so there is exactly one arg-mapping per
    // shared tool and it can never drift from the MCP host again (#445).
    const tools: Record<string, Tool> = {
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

      // --- WRITE tools (all reversible — history/trash; §6.5 / D3) ---

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

      getComment: tool({
        description: 'Fetch a single comment by id (content as Markdown).',
        inputSchema: modelFriendlyInput({
          commentId: z.string().describe('The id of the comment.'),
        }),
        execute: async ({ commentId }) => await client.getComment(commentId),
      }),

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

      // --- WRITE tools (added; reversible via page history/trash) ---

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

    // Add EVERY shared tool from the zod-agnostic registry in one loop (#445).
    // The spec owns the canonical arg->client mapping; this host only decides
    // WHICH mapping to run and returns its value directly (no envelope). For each
    // spec:
    //   - skip `mcpOnly` specs (they belong to the standalone MCP host only);
    //   - use `inAppExecute` when the spec declares a DELIBERATE per-layer
    //     difference (a projected result shape, a different guardrail message);
    //   - otherwise use the canonical `execute` (raw client result, identical to
    //     the MCP host's before it wraps it as JSON).
    // The execute receives the AI-SDK-validated, type-erased input; the spec reads
    // the same fields its buildShape declares. This is the SINGLE place the in-app
    // arg mapping lives — it can no longer silently drift from the MCP host.
    for (const spec of Object.values(sharedToolSpecs)) {
      if (spec.mcpOnly) continue;
      const run = spec.inAppExecute ?? spec.execute;
      if (!run) continue; // defensive: a shared spec always carries one of them.
      tools[spec.inAppKey] = sharedTool(
        spec,
        (async (args) =>
          run(client, args as Record<string, unknown>)) as Tool['execute'],
      );
    }

    // Passive "new comments: N" signal (#417). PER-TURN state (forUser runs once
    // per turn), so the watermark starts now and only comments a human leaves
    // WHILE this turn runs are signalled — exactly the mid-turn loop; between-turn
    // comments stay the job of the <page_changed> snapshot + explicit
    // checkNewComments. The count SOURCE is the same CASL-scoped loopback client
    // as the tools (option 2, symmetric with the standalone MCP): a rate-limited
    // listComments over the working-set pages. Chosen over the DB-count (option 1)
    // deliberately — a CommentRepo dependency would change this service's
    // constructor arity and force edits to every existing spec, breaking the
    // "existing tests stay green unchanged" contract; the REST probe needs no new
    // dependency and reuses the CASL enforcement already on `client`. When the
    // loaded package predates #417 (factory undefined) or the loader is mocked in
    // a unit test, signalling is a pure no-op and results are byte-identical.
    if (!createCommentSignalTracker) return tools;

    const tracker = createCommentSignalTracker({
      probe: async (pageId: string, sinceMs: number) => {
        const { items } = await client.listComments(pageId, true);
        const count = (items as Array<{ createdAt?: string }>).filter((c) => {
          const created = c?.createdAt ? new Date(c.createdAt).getTime() : NaN;
          return Number.isFinite(created) && created > sinceMs;
        }).length;
        let title: string | undefined;
        if (count > 0) {
          // Title labels the signal; untrusted, defanged by the shared builder.
          // Fetched only on a hit so the no-signal path never pays for it. Uses
          // the LIGHT raw page info (title only) — mirroring the standalone MCP
          // probe's getPageRaw — instead of the heavy getPage (which also renders
          // Markdown + subpages) just to read one field.
          try {
            const res = (await client.getPageRaw(pageId)) as {
              title?: string;
            } | null;
            title = res?.title ?? undefined;
          } catch {
            // Title is optional — omit it when the page can't be fetched.
          }
        }
        return { count, title };
      },
    });

    return wrapToolsWithCommentSignal(tools, tracker);
  }
}

/**
 * Wrap each in-app tool so a passive "new comments: N" line (#417) reaches the
 * MODEL without ever reshaping the tool's own output. NON-DESTRUCTIVE by design:
 *  - notes the call's `pageId` (if any) into the working set;
 *  - for a comment tool (listComments/checkNewComments/createComment) the result
 *    is tautological, so no signal is added and the watermark is advanced instead
 *    (the agent just consumed the feed);
 *  - `execute` ALWAYS returns the RAW original result. In AI SDK v6 that raw
 *    value is what streams to the UI and is persisted as the tool part's
 *    `output` (see apps/client `toolCitations`, which reads `output.id/title`
 *    and the searchPages array DIRECTLY), so `output` stays byte-identical to
 *    the no-signal path and citations are never lost.
 *  - the signal instead rides a SEPARATE channel the model sees but `output`
 *    consumers do not: `toModelOutput`, which the SDK invokes only when building
 *    the model-facing tool message (createToolModelOutput), independently of the
 *    streamed `output`. When a line exists we emit an MCP-style multi-part
 *    `content` result — the raw result as one text element plus the signal as a
 *    SECOND element — mirroring the standalone MCP surface's extra content
 *    element. With no line, `toModelOutput` reproduces the SDK's exact default
 *    (string -> text, else json), so the model sees the identical result too.
 * A per-`toolCallId` map bridges `execute` -> `toModelOutput` (both receive the
 * toolCallId), so parallel tool calls never cross-talk. Exported for unit
 * testing without a live model/transport.
 *
 * NOTE for future tool authors: this wrapper OWNS `toModelOutput` on every
 * wrapped tool, but it COMPOSES rather than discards a tool's OWN
 * `toModelOutput`. If a tool defines one, it is used as the base model output
 * (honored verbatim on the no-signal path; flattened and kept, with the signal
 * appended, on the signal path). A custom `toModelOutput` is therefore never
 * silently dropped.
 */
export function wrapToolsWithCommentSignal(
  tools: Record<string, Tool>,
  tracker: CommentSignalTrackerLike,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  // Bridges the dynamic per-call signal line from `execute` (where the tracker
  // runs) to `toModelOutput` (the model-only channel). Keyed by toolCallId so
  // concurrent tool calls cannot read each other's line; the entry is consumed
  // (deleted) the first time toModelOutput reads it.
  const pendingSignals = new Map<string, string>();

  // The SDK's DEFAULT model-output shape for a tool result, reproduced verbatim
  // so the no-signal path is model-identical to an unwrapped tool: a string
  // becomes text, anything else becomes json (undefined -> null, as toJSONValue).
  const defaultModelOutput = (output: unknown) =>
    typeof output === 'string'
      ? { type: 'text' as const, value: output }
      : { type: 'json' as const, value: (output ?? null) as unknown };

  // Flatten a BASE model-output (the tool's OWN toModelOutput result, or the SDK
  // default) into SDK `content` parts, so the passive signal can be appended as a
  // trailing text element WITHOUT discarding the base. Covers the three real SDK
  // shapes (text/json/content); falls back defensively for anything else. Every
  // returned item is a valid SDK content item (text, or a file part spread from
  // an existing `content` base).
  const modelOutputToParts = (base: unknown, rawOutput: unknown): unknown[] => {
    const b = base as { type?: string; value?: unknown };
    if (b?.type === 'text') {
      return [{ type: 'text' as const, text: b.value as string }];
    }
    if (b?.type === 'json') {
      // `?? null` keeps this symmetric with the fallback branch below: a tool that
      // (invalidly) returns {type:'json', value:undefined} would otherwise yield a
      // non-string text. No current tool defines toModelOutput, so this is defensive.
      return [{ type: 'text' as const, text: JSON.stringify(b.value ?? null) }];
    }
    if (b?.type === 'content' && Array.isArray(b.value)) {
      return [...b.value];
    }
    return [
      { type: 'text' as const, text: JSON.stringify(b?.value ?? rawOutput ?? null) },
    ];
  };

  for (const [name, toolDef] of Object.entries(tools)) {
    const originalExecute = toolDef.execute;
    // Capture the tool's OWN toModelOutput (if any) BEFORE we install ours. The
    // comment-signal wrapper OWNS `toModelOutput` on the wrapped tool, but it
    // COMPOSES rather than discards a tool-defined one: the base model output is
    // computed from `origToModelOutput` when present (see below), so a future
    // tool that ships its own `toModelOutput` is honored, not silently dropped.
    const origToModelOutput = toolDef.toModelOutput;
    if (typeof originalExecute !== 'function') {
      wrapped[name] = toolDef;
      continue;
    }
    wrapped[name] = {
      ...toolDef,
      execute: (async (args: unknown, opts: unknown) => {
        const pageId =
          args && typeof args === 'object'
            ? (args as { pageId?: unknown }).pageId
            : undefined;
        tracker.noteWorkingPage(
          typeof pageId === 'string' ? pageId : undefined,
        );

        const result = await (
          originalExecute as (a: unknown, o: unknown) => Promise<unknown>
        )(args, opts);

        // Excluded comment tool: consume the feed, never signal. Raw result.
        if (tracker.isExcludedTool(name)) {
          tracker.advanceWatermark();
          return result;
        }
        let line: string | null = null;
        try {
          line = await tracker.maybeSignal(name);
        } catch {
          line = null;
        }
        // Stash the line for toModelOutput (keyed by this call's id). The RAW
        // result is ALWAYS returned unchanged so `part.output` is byte-identical
        // to the no-signal path.
        const toolCallId =
          opts && typeof opts === 'object'
            ? (opts as { toolCallId?: unknown }).toolCallId
            : undefined;
        if (line && typeof toolCallId === 'string') {
          pendingSignals.set(toolCallId, line);
        }
        return result;
      }) as Tool['execute'],
      // Model-only delivery: append the signal as a SEPARATE content element,
      // leaving the streamed/persisted `output` untouched (mirrors MCP). This
      // OWNS toModelOutput but COMPOSES the tool's own (origToModelOutput) into
      // the base, so a custom toModelOutput is honored on BOTH paths.
      toModelOutput: ((info: {
        toolCallId?: string;
        input?: unknown;
        output?: unknown;
      }) => {
        const { toolCallId, output } = info;
        const line =
          typeof toolCallId === 'string'
            ? pendingSignals.get(toolCallId)
            : undefined;
        if (typeof toolCallId === 'string' && line !== undefined) {
          pendingSignals.delete(toolCallId);
        }
        // BASE = the authoritative model-facing representation of THIS tool's
        // result: the tool's own toModelOutput when it defined one, else the
        // reproduced SDK default (string -> text, else json).
        const base = origToModelOutput
          ? (origToModelOutput as (i: unknown) => unknown)(info)
          : defaultModelOutput(output);
        // No signal: return the BASE unchanged — byte-identical to what the SDK
        // (or the tool's own toModelOutput) would have produced.
        if (!line) return base;
        // Signal present: flatten BASE into content parts, then append the
        // signal as a trailing text element — the model sees BOTH the tool's own
        // model output AND the signal, with no `.result` wrapper to dig under.
        return {
          type: 'content' as const,
          value: [
            ...modelOutputToParts(base, output),
            { type: 'text' as const, text: line },
          ],
        };
      }) as Tool['toModelOutput'],
    } as Tool;
  }
  return wrapped;
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
