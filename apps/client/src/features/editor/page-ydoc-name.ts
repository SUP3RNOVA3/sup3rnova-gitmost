/**
 * Single source of truth for the IndexedDB / Hocuspocus document name of a
 * page's collaborative Yjs doc.
 *
 * The `page.<id>` convention is shared knowledge across three call sites: the
 * live editor providers (`use-page-collab-providers`), the offline warm path
 * (`make-offline`), and the offline purge (`clear-offline-cache`, which matches
 * the databases to delete by this prefix). Centralizing it here stops those
 * sites from silently drifting apart.
 */
export const PAGE_YDOC_NAME_PREFIX = "page.";

export const pageYdocName = (pageId: string): string =>
  `${PAGE_YDOC_NAME_PREFIX}${pageId}`;
