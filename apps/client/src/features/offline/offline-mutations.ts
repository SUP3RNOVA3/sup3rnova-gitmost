import type { QueryClient } from "@tanstack/react-query";
import { createPage, movePage } from "@/features/page/services/page-service";
import { createComment } from "@/features/comment/services/comment-service";
import { invalidateOnCreatePage } from "@/features/page/queries/page-query";
import type {
  IMovePage,
  IPage,
  IPageInput,
} from "@/features/page/types/page.types";
import type { IComment } from "@/features/comment/types/comment.types";

/**
 * Stable mutation keys for the offline-relevant structural mutations.
 *
 * When the browser goes offline, React Query PAUSES these mutations and the
 * PersistQueryClientProvider dehydrates the paused mutation into IndexedDB. On a
 * reload-while-offline the mutation is restored, but a restored mutation has NO
 * observer (no component is mounted) — so its replay relies entirely on the
 * `mutationFn` registered via `setMutationDefaults` for its `mutationKey`.
 * Without that, `resumePausedMutations()` finds a paused mutation with no
 * `mutationFn` and silently no-ops, dropping the offline create/move/comment
 * (#237/#238). Each offline mutation hook tags itself with the matching key so
 * the rehydrated paused mutation can find its default `mutationFn` and replay.
 */
export const offlineMutationKeys = {
  createPage: ["create-page"] as const,
  movePage: ["move-page"] as const,
  createComment: ["create-comment"] as const,
};

/**
 * Register default `mutationFn`s (and the minimal success side effects safe to
 * run without a mounted component) for the offline-relevant mutation keys, so a
 * paused mutation restored from IndexedDB after an offline reload is replayable
 * by `resumePausedMutations()` on reconnect.
 *
 * Called once when the QueryClient is created (see main.tsx). The hooks still
 * carry their own inline `mutationFn`/`onSuccess` for the live in-session path;
 * these defaults only take over for a rehydrated paused mutation that lost its
 * observer across the reload.
 */
export function registerOfflineMutationDefaults(queryClient: QueryClient): void {
  queryClient.setMutationDefaults(offlineMutationKeys.createPage, {
    mutationFn: (data: Partial<IPageInput>) => createPage(data),
    // Re-converge the sidebar tree / recent-changes from the authoritative
    // create response. Pure cache writes — safe with no component mounted.
    onSuccess: (data: IPage) => {
      invalidateOnCreatePage(data);
    },
  });

  queryClient.setMutationDefaults(offlineMutationKeys.movePage, {
    // Replay the server-side move. The tree re-converges from the next online
    // sidebar fetch / websocket `moveTreeNode` echo, so no cache write is
    // needed here (the optimistic tree state was local-only anyway).
    mutationFn: (data: IMovePage) => movePage(data),
  });

  queryClient.setMutationDefaults(offlineMutationKeys.createComment, {
    // Replay the server-side comment create. The comments list refetches on the
    // online reload, so the replay only needs to persist the write.
    mutationFn: (data: Partial<IComment>) => createComment(data),
  });
}
