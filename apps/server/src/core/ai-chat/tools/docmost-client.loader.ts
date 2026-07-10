import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DocmostClient, SharedToolSpec } from '@docmost/mcp';

// Re-export SharedToolSpec so downstream server modules keep a single import
// path (they import it from this loader). The shape is DERIVED from the package
// entry, not re-declared here — see the import above (issue #446).
export type { SharedToolSpec } from '@docmost/mcp';

/**
 * The exact set of `DocmostClient` methods the per-user in-app tool adapter
 * consumes. This is the AUTHORITATIVE list of the client surface the server
 * depends on; the adapter calls these methods POSITIONALLY, so this set is what
 * the derived type below type-checks against the real class (issue #446).
 */
type DocmostClientMethod =
  // --- read ---
  | 'search'
  | 'getPage'
  | 'getPageRaw'
  | 'getWorkspace'
  | 'getSpaces'
  | 'listPages'
  | 'listSidebarPages'
  | 'getOutline'
  | 'getPageJson'
  | 'getNode'
  | 'searchInPage'
  | 'getTable'
  | 'listComments'
  | 'getComment'
  | 'checkNewComments'
  | 'listShares'
  | 'listPageHistory'
  | 'getPageHistory'
  | 'diffPageVersions'
  | 'exportPageMarkdown'
  // --- write (page) ---
  | 'createPage'
  | 'updatePage'
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
  | 'transformPage'
  | 'stashPage'
  // --- write (image / footnote), in-app since #410 ---
  | 'insertImage'
  | 'replaceImage'
  | 'insertFootnote'
  // --- draw.io diagrams (#423 stage 1, #424 stage 2) ---
  // DERIVED from the real DocmostClient (#446): drawioCreate/drawioUpdate carry
  // the optional layout:"elk" 5th arg in the real signature, so the layout parity
  // (#440) is inherited automatically — no hand-written mirror to keep in sync.
  | 'drawioGet'
  | 'drawioCreate'
  | 'drawioUpdate'
  // --- write (comment) ---
  | 'createComment'
  | 'resolveComment';

/**
 * The client surface the per-user tool adapter consumes, DERIVED from the real
 * `DocmostClient` type in `@docmost/mcp` (issue #446, restored #294 debt). This
 * replaces the former hand-mirror of ~45 method signatures.
 *
 * `import type` (above) is fully ERASED at compile time, so nothing is actually
 * imported from the ESM-only package at runtime — the server still loads the
 * class through the dynamic `import()` trick in `loadDocmostMcp` below; this is
 * purely a compile-time type. Deriving via `Pick` means a parameter reorder or a
 * type change to any of these methods in `client.ts` now becomes a SERVER
 * COMPILE ERROR at the positional call sites in ai-chat-tools.service.ts,
 * instead of a silent runtime "wrong argument" failure inside an agent tool.
 *
 * This made the old name-only drift-guard test
 * (packages/mcp/test/unit/client-host-contract.test.mjs) redundant — tsc now
 * enforces both names AND signatures — so that test was removed.
 */
export type DocmostClientLike = Pick<DocmostClient, DocmostClientMethod>;

export type DocmostClientConfig = {
  apiUrl: string;
  getToken: () => Promise<string>;
  // Provenance collab-token provider for content mutations (signed agent claim).
  getCollabToken?: () => Promise<string>;
  // Optional blob-sandbox sink for the stash tool. `put` stores a blob in the
  // host's in-RAM SandboxStore and returns the anonymous read URL + integrity.
  // The optional `has`/`evict` probes let stashPage keep its mirror counts
  // honest under the store's FIFO eviction (mirror of the package's sink type).
  sandbox?: {
    put: (
      buf: Buffer,
      mime: string,
    ) => { uri: string; sha256: string; size: number };
    has?: (uri: string) => boolean;
    evict?: (uri: string) => void;
  };
};

export interface DocmostClientCtor {
  new (config: DocmostClientConfig): DocmostClient;
}

/**
 * Local hand-mirror of the "new comments: N" signal helper (#417) exported from
 * `@docmost/mcp` (packages/mcp/src/comment-signal.ts). Same cross-boundary
 * approach as `SharedToolSpec`: we do not import the ESM package's types. The
 * factory owns the transport-neutral watermark/debounce/injection-safe line
 * builder; the in-app layer supplies its own `probe` (REST `listComments`) and
 * result shaping.
 */
export interface CommentSignalProbeResultLike {
  count: number;
  title?: string | null;
}

export interface CommentSignalTrackerLike {
  noteWorkingPage(pageId: string | undefined | null): void;
  advanceWatermark(nowMs?: number): void;
  isExcludedTool(toolName: string): boolean;
  maybeSignal(toolName: string): Promise<string | null>;
}

export type CommentSignalTrackerFactory = (options: {
  probe: (
    pageId: string,
    sinceMs: number,
  ) => Promise<CommentSignalProbeResultLike>;
  now?: () => number;
  debounceMs?: number;
}) => CommentSignalTrackerLike;

// Pure, no-network draw.io helpers (#424). These are plain functions on the
// module (NOT DocmostClient methods) — the in-app AI-SDK service calls them
// directly to wire drawio_shapes / drawio_guide, mirroring the MCP server.
export type SearchShapesFn = (
  query: string,
  opts?: { category?: string; limit?: number },
) => Array<Record<string, unknown>>;
export type GetGuideSectionFn = (section?: string) => {
  section: string;
  content: string;
  sections: string[];
};

interface DocmostMcpModule {
  DocmostClient: DocmostClientCtor;
  SHARED_TOOL_SPECS: Record<string, SharedToolSpec>;
  // Optional (#417): absent on a pre-#417 @docmost/mcp build and on the mocked
  // loader in unit tests. The in-app layer treats an absent factory as "signal
  // disabled" — a pure no-op that leaves tool results byte-identical.
  createCommentSignalTracker?: CommentSignalTrackerFactory;
  // Optional (#447): a deterministic hash of the tool-specs registry content,
  // generated into build/ by the package's build. Absent on a pre-#447 build (or
  // the mocked loader in unit tests) — the stale-check below is a NO-OP when it
  // is missing, so an older build never wrongly fails startup.
  REGISTRY_STAMP?: string;
  // Pure, no-network draw.io helpers (#424). Still exposed off the loaded module
  // so unit-test loader mocks can stub them, but the in-app tool wiring no longer
  // calls them directly: drawio_shapes / drawio_guide are ordinary
  // SHARED_TOOL_SPECS entries whose canonical execute (in the mcp package) invokes
  // searchShapes / getGuideSection, so parity with the MCP host comes from the
  // shared registry loop, not a hand-mirrored in-app handler.
  searchShapes: SearchShapesFn;
  getGuideSection: GetGuideSectionFn;
}

/**
 * Recompute the REGISTRY_STAMP (#447) from the @docmost/mcp source tree, if it is
 * present. Returns the stamp string, or `null` when the source is absent (a prod
 * image ships only build/, no src/). MUST stay byte-for-byte identical to
 * packages/mcp/scripts/gen-registry-stamp.mjs's `computeRegistryStamp` so the
 * build-time and src-time hashes agree: same input file (src/tool-specs.ts), same
 * normalization (CRLF -> LF, strip a single trailing newline), same sha256.
 *
 * DEV vs PROD detection is by FILE EXISTENCE, not NODE_ENV: we resolve the
 * package's own directory from `require.resolve('@docmost/mcp')` (which points at
 * build/index.js) and look for ../src/tool-specs.ts next to it. In a dev/test
 * worktree that file exists; in a prod image (build/ only, src/ stripped) it does
 * not, so this returns null and the caller skips the check. Any error (ENOENT, a
 * bad resolve) is swallowed to null — the stale-check must NEVER break startup.
 *
 * Exported for unit testing (docmost-client.loader.spec.ts): the export keyword
 * is behaviourally a no-op — the module-internal caller `loadDocmostMcp` is
 * unaffected. The test drives the null (no-src) path and asserts this
 * normalize+sha256 stays identical to the codegen's `computeRegistryStamp`.
 */
export function computeSrcRegistryStamp(packageEntry: string): string | null {
  try {
    // packageEntry is <pkg>/build/index.js; the source lives at <pkg>/src/.
    const toolSpecsPath = join(
      dirname(dirname(packageEntry)),
      'src',
      'tool-specs.ts',
    );
    if (!existsSync(toolSpecsPath)) return null; // prod: no src tree -> skip.
    const source = readFileSync(toolSpecsPath, 'utf8');
    const normalized = source.replace(/\r\n/g, '\n').replace(/\n$/, '');
    return createHash('sha256').update(normalized, 'utf8').digest('hex');
  } catch {
    // Never let a resolution/read hiccup break server startup — treat as "no
    // src available" and skip the check (identical to the prod no-op path).
    return null;
  }
}

// TS with module:commonjs downlevels a literal `import()` to `require()`, which
// cannot load the ESM-only `@docmost/mcp` package. Indirect through Function so
// the real dynamic `import()` survives compilation and can load ESM from
// CommonJS at runtime (same trick as integrations/mcp/mcp.service.ts).
const esmImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>;

// Memoize the in-flight/loaded module so the dynamic import runs at most once.
let modulePromise: Promise<DocmostMcpModule> | null = null;

/**
 * Lazily load the ESM-only `@docmost/mcp` package and return its
 * `DocmostClient` constructor. Resolves the package entry to an absolute path,
 * then imports it as a `file://` URL so the package "exports" map is honoured
 * without bare-specifier resolution-base fragility.
 */
export async function loadDocmostMcp(): Promise<{
  DocmostClient: DocmostClientCtor;
  sharedToolSpecs: Record<string, SharedToolSpec>;
  createCommentSignalTracker?: CommentSignalTrackerFactory;
  searchShapes: SearchShapesFn;
  getGuideSection: GetGuideSectionFn;
}> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const entry = require.resolve('@docmost/mcp');
      const mod = (await esmImport(
        pathToFileURL(entry).href,
      )) as DocmostMcpModule;
      // #447 stale-build guard (dev/test only). The server loads the COMPILED
      // build/ of @docmost/mcp, but the parity/tier guard tests read src/. If a
      // tool spec is edited in src without rebuilding the package, build/ and src/
      // silently diverge and the running server serves the OLD tools. Here we
      // recompute the stamp from src/tool-specs.ts and compare it to the stamp
      // baked into build/. In PROD the src tree is absent (image ships build/
      // only), so computeSrcRegistryStamp returns null and this is a pure no-op.
      const srcStamp = computeSrcRegistryStamp(entry);
      if (
        srcStamp !== null &&
        typeof mod.REGISTRY_STAMP === 'string' &&
        srcStamp !== mod.REGISTRY_STAMP
      ) {
        throw new Error(
          '@docmost/mcp build is stale (tool-specs changed since last build) — run: pnpm --filter @docmost/mcp build',
        );
      }
      return mod;
    })().catch((err) => {
      // Do not cache a rejected import — allow the next call to retry.
      modulePromise = null;
      throw err;
    });
  }
  const mod = await modulePromise;
  if (!mod.SHARED_TOOL_SPECS) {
    // A stale @docmost/mcp build (missing the shared registry export) would
    // otherwise surface as a confusing TypeError deep in the tools service.
    throw new Error(
      '@docmost/mcp is stale: SHARED_TOOL_SPECS missing — rebuild the package (pnpm --filter @docmost/mcp build).',
    );
  }
  return {
    DocmostClient: mod.DocmostClient,
    sharedToolSpecs: mod.SHARED_TOOL_SPECS,
    // Optional: forwarded when present so the in-app layer can build the passive
    // comment signal (#417); undefined on a stale build => signal disabled.
    createCommentSignalTracker: mod.createCommentSignalTracker,
    // Pure no-network draw.io helpers (#424); not client methods.
    searchShapes: mod.searchShapes,
    getGuideSection: mod.getGuideSection,
  };
}
