import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { HocuspocusProvider } from "@hocuspocus/provider";

import { queryClient } from "@/main.tsx";
import {
  getPageById,
  getPageBreadcrumbs,
  getSidebarPages,
  getAllSidebarPages,
} from "@/features/page/services/page-service";
import { getSpaceById } from "@/features/space/services/space-service.ts";
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
 * Best-effort: any failure is swallowed so a partial/failed warm never throws.
 *
 * Exported for unit testing of the cursor-walk / cache-write behavior.
 */
export async function warmInfiniteAll<T>(
  queryKey: unknown[],
  fetchPage: (cursor: string | undefined) => Promise<IPagination<T>>,
  maxPages = 50,
): Promise<void> {
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
  } catch {
    // best-effort
  }
}

export interface MakePageAvailableOfflineParams {
  pageId: string;
  slugId?: string;
  spaceId?: string;
  parentPageId?: string;
}

/**
 * Best-effort prefetch of a page's read queries so they get persisted to
 * IndexedDB and become readable offline.
 *
 * Each prefetch is isolated in try/catch — this function NEVER throws to its
 * caller. Only meaningful while online (the underlying requests must succeed).
 */
export async function makePageAvailableOffline({
  pageId,
  spaceId,
}: MakePageAvailableOfflineParams): Promise<void> {
  // Fetch the page document ONCE and write it under BOTH cache keys, exactly
  // like usePageQuery's onData effect. Every page consumer reads ["pages",
  // <slugId>] (usePageQuery keys on the slugId for routed reads), so warming
  // only ["pages", <uuid>] would leave the offline page blank.
  let page: IPage | undefined;
  try {
    page = await getPageById({ pageId });
    queryClient.setQueryData(["pages", page.slugId], page);
    queryClient.setQueryData(["pages", page.id], page);
  } catch {
    // best-effort
  }

  // Warm the space — page.tsx renders nothing until the space query resolves
  // (useGetSpaceBySlugQuery → ["space", <spaceSlug>]). Awaited (not the
  // fire-and-forget prefetchSpace) so the space is actually persisted before
  // the caller fires its success toast. Matches the hook's key/fn exactly.
  try {
    const spaceSlug = page?.space?.slug;
    if (spaceSlug) {
      await queryClient.prefetchQuery({
        queryKey: ["space", spaceSlug],
        queryFn: () => getSpaceById(spaceSlug),
      });
    }
  } catch {
    // best-effort
  }

  // Warm the sidebar tree root so the WHOLE root level renders offline (matches
  // useGetRootSidebarPagesQuery's ["root-sidebar-pages", spaceId] infinite
  // key/fn). Fully paginated so large root levels are not truncated at 100.
  if (spaceId) {
    await warmInfiniteAll(["root-sidebar-pages", spaceId], (cursor) =>
      getSidebarPages({ spaceId, cursor, limit: 100 }),
    );
  }

  // Warm the children of the page and of every ancestor so the path to this
  // page is expandable offline. We MIRROR fetchAllAncestorChildren exactly —
  // same regular ["sidebar-pages", { pageId, spaceId }] key, same
  // getAllSidebarPages fn (which aggregates ALL children pages, so nothing is
  // truncated at 100), same 30min staleTime — otherwise the warmed cache would
  // never be read by the offline tree.
  const warmSidebarChildren = async (id: string) => {
    try {
      // Keep EXACTLY { pageId, spaceId } so the key hashes identically to
      // fetchAllAncestorChildren's (no parentPageId, no extra fields).
      const params = { pageId: id, spaceId };
      await queryClient.prefetchQuery({
        queryKey: ["sidebar-pages", params],
        queryFn: () => getAllSidebarPages(params),
        staleTime: 30 * 60 * 1000,
      });
    } catch {
      // best-effort per node
    }
  };

  // The page's own children.
  await warmSidebarChildren(pageId);

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
      await warmSidebarChildren(ancestorId);
    }
  } catch {
    // best-effort
  }

  // Comments (matches useCommentsQuery's ["comments", pageId] infinite cache).
  // useCommentsQuery reports isLoading while hasNextPage is true, so warming
  // only the first page leaves the offline comments panel spinning forever on
  // pages with >100 comments. Fully paginate so the last cached page has no
  // nextCursor and the panel settles offline.
  await warmInfiniteAll(["comments", pageId], (cursor) =>
    getPageComments({ pageId, cursor, limit: 100 }),
  );
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
