import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { HocuspocusProvider } from "@hocuspocus/provider";

import { queryClient } from "@/main.tsx";
import {
  getPageById,
  getPageBreadcrumbs,
  getSidebarPages,
} from "@/features/page/services/page-service";
import {
  pageKeys,
  sidebarPagesQueryOptions,
} from "@/features/page/queries/page-query";
import { spaceByIdQueryOptions } from "@/features/space/queries/space-query";
import { RQ_KEY } from "@/features/comment/queries/comment-query";
import { getPageComments } from "@/features/comment/services/comment-service";
import { IPage } from "@/features/page/types/page.types";
import { IPagination } from "@/lib/types.ts";

/**
 * Fully paginate an infinite query and write the @tanstack InfiniteData cache
 * shape ({ pages, pageParams }) that the matching useInfiniteQuery hook reads.
 *
 * The default prefetchInfiniteQuery only warms the FIRST page, which leaves
 * hooks that treat hasNextPage as still-loading (e.g. the comments panel)
 * spinning forever offline, and silently truncates large lists. This walks the
 * cursor chain until it runs out (or hits maxPages) so the whole list is cached.
 *
 * Best-effort: a failure does not throw (a partial/failed warm is still useful),
 * but it is reported — the error is logged with context and `false` is returned
 * so the caller can record the failed step instead of silently succeeding.
 *
 * Returns true if the whole list was paginated and written, false on any error.
 *
 * Exported for unit testing of the cursor-walk / cache-write behavior.
 */
export async function warmInfiniteAll<T>(
  queryKey: readonly unknown[],
  fetchPage: (cursor: string | undefined) => Promise<IPagination<T>>,
  maxPages = 50,
): Promise<boolean> {
  try {
    const pages: IPagination<T>[] = [];
    const pageParams: (string | undefined)[] = [];
    let cursor: string | undefined = undefined;

    for (let i = 0; i < maxPages; i++) {
      const res = await fetchPage(cursor);
      pages.push(res);
      pageParams.push(cursor);
      cursor = res?.meta?.nextCursor ?? undefined;
      if (!cursor) break;
    }

    queryClient.setQueryData(queryKey, { pages, pageParams });
    return true;
  } catch (error) {
    console.error("warmInfiniteAll failed", { queryKey, error });
    return false;
  }
}

export interface MakePageAvailableOfflineParams {
  pageId: string;
  spaceId?: string;
}

/**
 * Outcome of {@link makePageAvailableOffline}. `ok` is true only when every warm
 * step succeeded; `failed` lists the labels of the steps that failed (a subset
 * of: "page", "space", "tree", "breadcrumbs", "comments").
 */
export interface MakePageAvailableOfflineResult {
  ok: boolean;
  failed: string[];
}

/**
 * Best-effort prefetch of a page's read queries so they get persisted to
 * IndexedDB and become readable offline.
 *
 * Each step is isolated and this function does NOT throw — a partial warm is
 * still useful. Instead of silently succeeding, every failed step is logged
 * with a label and recorded in the returned result: `{ ok, failed }` where
 * `ok` is true only if no step failed and `failed` lists the failed step
 * labels. Only meaningful while online (the underlying requests must succeed).
 */
export async function makePageAvailableOffline({
  pageId,
  spaceId,
}: MakePageAvailableOfflineParams): Promise<MakePageAvailableOfflineResult> {
  const failed: string[] = [];

  // Fetch the page document ONCE and write it under BOTH cache keys, exactly
  // like usePageQuery's onData effect. Every page consumer reads
  // pageKeys.detail(slugId) (usePageQuery keys on the slugId for routed reads),
  // so warming only the uuid key would leave the offline page blank.
  let page: IPage | undefined;
  try {
    page = await getPageById({ pageId });
    queryClient.setQueryData(pageKeys.detail(page.slugId), page);
    queryClient.setQueryData(pageKeys.detail(page.id), page);
  } catch (error) {
    console.error("makePageAvailableOffline: page step failed", {
      pageId,
      error,
    });
    failed.push("page");
  }

  // Warm the space — page.tsx renders nothing until the space query resolves
  // (useGetSpaceBySlugQuery). Awaited (not the fire-and-forget prefetchSpace) so
  // the space is actually persisted before the caller fires its toast. Shares
  // spaceByIdQueryOptions so the key/fn cannot drift from the hook.
  try {
    const spaceSlug = page?.space?.slug;
    if (spaceSlug) {
      await queryClient.prefetchQuery(spaceByIdQueryOptions(spaceSlug));
    }
  } catch (error) {
    console.error("makePageAvailableOffline: space step failed", {
      pageId,
      error,
    });
    failed.push("space");
  }

  // Warm the sidebar tree root so the WHOLE root level renders offline (matches
  // useGetRootSidebarPagesQuery's pageKeys.rootSidebar(spaceId) infinite cache).
  // Fully paginated so large root levels are not truncated at 100.
  if (spaceId) {
    const ok = await warmInfiniteAll(pageKeys.rootSidebar(spaceId), (cursor) =>
      getSidebarPages({ spaceId, cursor, limit: 100 }),
    );
    if (!ok) failed.push("tree");
  }

  // Warm the children of the page and of every ancestor so the path to this
  // page is expandable offline. We MIRROR fetchAllAncestorChildren exactly via
  // sidebarPagesQueryOptions — same pageKeys.sidebar({ pageId, spaceId }) key,
  // same getAllSidebarPages fn (which aggregates ALL children pages, so nothing
  // is truncated at 100), same 30min staleTime — otherwise the warmed cache
  // would never be read by the offline tree.
  const warmSidebarChildren = async (id: string): Promise<boolean> => {
    try {
      // Keep EXACTLY { pageId, spaceId } so the key hashes identically to
      // fetchAllAncestorChildren's (no parentPageId, no extra fields).
      const params = { pageId: id, spaceId };
      await queryClient.prefetchQuery(sidebarPagesQueryOptions(params));
      return true;
    } catch (error) {
      console.error("makePageAvailableOffline: tree node step failed", {
        pageId: id,
        error,
      });
      return false;
    }
  };

  // The page's own children.
  if (!(await warmSidebarChildren(pageId))) failed.push("tree");

  // Each ancestor's children. Use the breadcrumbs endpoint ONLY to discover the
  // ancestor ids — we intentionally do NOT cache the breadcrumbs themselves
  // (the UI derives the path from the tree).
  try {
    const ancestors = (await getPageBreadcrumbs(pageId)) as
      | Array<{ id?: string }>
      | undefined;
    for (const ancestor of ancestors ?? []) {
      const ancestorId = ancestor?.id;
      if (!ancestorId || ancestorId === pageId) continue;
      if (!(await warmSidebarChildren(ancestorId))) failed.push("tree");
    }
  } catch (error) {
    console.error("makePageAvailableOffline: breadcrumbs step failed", {
      pageId,
      error,
    });
    failed.push("breadcrumbs");
  }

  // Comments (matches useCommentsQuery's RQ_KEY(pageId) infinite cache).
  // useCommentsQuery reports isLoading while hasNextPage is true, so warming
  // only the first page leaves the offline comments panel spinning forever on
  // pages with >100 comments. Fully paginate so the last cached page has no
  // nextCursor and the panel settles offline.
  const commentsOk = await warmInfiniteAll(RQ_KEY(pageId), (cursor) =>
    getPageComments({ pageId, cursor, limit: 100 }),
  );
  if (!commentsOk) failed.push("comments");

  // Dedupe — the tree label can be recorded once per failed node/ancestor.
  const uniqueFailed = [...new Set(failed)];
  return { ok: uniqueFailed.length === 0, failed: uniqueFailed };
}

/**
 * Best-effort warm-up of the page's Yjs document into IndexedDB so the editor
 * can open offline.
 *
 * Opens a local IndexeddbPersistence plus a transient HocuspocusProvider to
 * pull the server state into IndexedDB, then tears both down once synced (or
 * after a timeout). Entirely wrapped in try/catch — NEVER throws.
 *
 * Only meaningful when online at warm time; offline it is a no-op that resolves.
 */
export async function warmPageYdoc(
  pageId: string,
  collabUrl: string,
  token?: string,
): Promise<void> {
  let ydoc: Y.Doc | null = null;
  let local: IndexeddbPersistence | null = null;
  let remote: HocuspocusProvider | null = null;

  try {
    const documentName = `page.${pageId}`;
    ydoc = new Y.Doc();
    local = new IndexeddbPersistence(documentName, ydoc);
    remote = new HocuspocusProvider({
      url: collabUrl,
      name: documentName,
      document: ydoc,
      token,
    });

    const provider = remote;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        // Clear the pending timeout and detach the listener so neither leaks
        // after we resolve.
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        try {
          provider.off("synced", finish);
        } catch {
          // best-effort
        }
        resolve();
      };

      // Resolve once the server state has synced into the local doc...
      provider.on("synced", finish);
      // ...or give up after a short timeout so we never hang.
      timeoutId = setTimeout(finish, 8000);
    });
  } catch {
    // best-effort
  } finally {
    try {
      remote?.destroy();
    } catch {
      // best-effort
    }
    try {
      local?.destroy();
    } catch {
      // best-effort
    }
    try {
      ydoc?.destroy();
    } catch {
      // best-effort
    }
  }
}
