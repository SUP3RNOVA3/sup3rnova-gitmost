import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  InfiniteData,
} from "@tanstack/react-query";
import {
  applySuggestion,
  createComment,
  deleteComment,
  dismissSuggestion,
  getPageComments,
  resolveComment,
  updateComment,
} from "@/features/comment/services/comment-service";
import {
  ICommentParams,
  IComment,
  IResolveComment,
  ISuggestionOutcome,
} from "@/features/comment/types/comment.types";
import { notifications } from "@mantine/notifications";
import { IPagination } from "@/lib/types.ts";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo } from "react";

export const RQ_KEY = (pageId: string) => ["comments", pageId];

export function useCommentsQuery(params: ICommentParams) {
  const query = useInfiniteQuery({
    queryKey: RQ_KEY(params.pageId),
    queryFn: ({ pageParam }) =>
      getPageComments({ pageId: params.pageId, cursor: pageParam, limit: 100 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasNextPage ? lastPage.meta.nextCursor : undefined,
    enabled: !!params.pageId,
  });

  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query.hasNextPage, query.isFetchingNextPage, query.fetchNextPage]);

  const data = useMemo<IPagination<IComment> | undefined>(() => {
    if (!query.data) return undefined;
    return {
      items: query.data.pages.flatMap((p) => p.items),
      meta: query.data.pages[query.data.pages.length - 1].meta,
    };
  }, [query.data]);

  return {
    data,
    isLoading: query.isLoading || query.hasNextPage,
    isError: query.isError,
  };
}

export function useCreateCommentMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IComment, Error, Partial<IComment>>({
    mutationFn: (data) => createComment(data),
    onSuccess: (newComment) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(newComment.pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache && cache.pages.length > 0) {
        const alreadyExists = cache.pages.some((page) =>
          page.items.some((c) => c.id === newComment.id),
        );
        if (alreadyExists) return;

        const lastIdx = cache.pages.length - 1;
        queryClient.setQueryData(RQ_KEY(newComment.pageId), {
          ...cache,
          pages: cache.pages.map((page, i) =>
            i === lastIdx
              ? { ...page, items: [...page.items, newComment] }
              : page,
          ),
        });
      }

      notifications.show({ message: t("Comment created successfully") });
    },
    onError: () => {
      notifications.show({
        message: t("Error creating comment"),
        color: "red",
      });
    },
  });
}

export function useUpdateCommentMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<IComment, Error, Partial<IComment>>({
    mutationFn: (data) => updateComment(data),
    onSuccess: (updatedComment) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(updatedComment.pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache) {
        queryClient.setQueryData(RQ_KEY(updatedComment.pageId), {
          ...cache,
          pages: cache.pages.map((page) => ({
            ...page,
            items: page.items.map((comment) =>
              comment.id === updatedComment.id ? updatedComment : comment,
            ),
          })),
        });
      }

      notifications.show({ message: t("Comment updated successfully") });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to update comment"),
        color: "red",
      });
    },
  });
}

export function useDeleteCommentMutation(pageId?: string) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: (_data, commentId) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache) {
        queryClient.setQueryData(RQ_KEY(pageId), {
          ...cache,
          pages: cache.pages.map((page) => ({
            ...page,
            items: page.items.filter((comment) => comment.id !== commentId),
          })),
        });
      }

      notifications.show({ message: t("Comment deleted successfully") });
    },
    onError: () => {
      notifications.show({
        message: t("Failed to delete comment"),
        color: "red",
      });
    },
  });
}

function updateCommentInCache(
  cache: InfiniteData<IPagination<IComment>>,
  commentId: string,
  updater: (comment: IComment) => IComment,
): InfiniteData<IPagination<IComment>> {
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      items: page.items.map((comment) =>
        comment.id === commentId ? updater(comment) : comment,
      ),
    })),
  };
}

function removeCommentFromCache(
  cache: InfiniteData<IPagination<IComment>>,
  commentId: string,
): InfiniteData<IPagination<IComment>> {
  return {
    ...cache,
    pages: cache.pages.map((page) => ({
      ...page,
      items: page.items.filter((comment) => comment.id !== commentId),
    })),
  };
}

// Reconcile the local comment cache with an ephemeral-suggestion outcome (#329)
// returned by apply/dismiss: 'deleted' → drop the comment (it disappeared);
// 'resolved' → the thread had replies and was resolved, so carry the resolved
// state through (which relocates it to the resolved tab).
function applySuggestionOutcomeToCache(
  queryClient: ReturnType<typeof useQueryClient>,
  pageId: string,
  commentId: string,
  data: ISuggestionOutcome,
) {
  const cache = queryClient.getQueryData(RQ_KEY(pageId)) as
    | InfiniteData<IPagination<IComment>>
    | undefined;
  if (!cache) return;

  if (data.outcome === "deleted") {
    queryClient.setQueryData(RQ_KEY(pageId), removeCommentFromCache(cache, commentId));
    return;
  }

  // 'resolved' (or an older server that omits outcome): reflect the resolved
  // state and the applied stamps (apply sets them; dismiss leaves them null).
  queryClient.setQueryData(
    RQ_KEY(pageId),
    updateCommentInCache(cache, commentId, (comment) => ({
      ...comment,
      suggestionAppliedAt: data.suggestionAppliedAt,
      suggestionAppliedById: data.suggestionAppliedById,
      resolvedAt: data.resolvedAt,
      resolvedById: data.resolvedById,
      resolvedBy: data.resolvedBy,
    })),
  );
}

export function useApplySuggestionMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    ISuggestionOutcome,
    any,
    { commentId: string; pageId: string }
  >({
    // No optimistic update: apply can fail with 409 (the commented text drifted),
    // so we only mutate the cache once the server confirms.
    mutationFn: ({ commentId }) => applySuggestion(commentId),
    onSuccess: (data, variables) => {
      // Ephemeral (#329): the server hard-deletes the applied suggestion when the
      // thread has no replies ('deleted') or resolves it when it does ('resolved').
      applySuggestionOutcomeToCache(
        queryClient,
        variables.pageId,
        variables.commentId,
        data,
      );

      notifications.show({ message: t("Suggestion applied") });
    },
    onError: (err: any, variables) => {
      const status = err?.response?.status;
      // Idempotent race (double-click, or apply↔dismiss): after #329 an applied
      // reply-less suggestion is hard-deleted, so a second/racing apply hits 404
      // (already gone). ONLY 404 is a real success-noop — drop it from the cache
      // and report success, the user's intent is already satisfied (restores the
      // #315 apply idempotency the ephemeral delete would otherwise break).
      //
      // 400 is NOT success (#338 F2): apply's only 400 is "Cannot apply … on a
      // resolved comment thread" — the thread was resolved (often WITH a live
      // discussion) but the edit was NOT applied. Treating it as "Suggestion
      // applied" is a false success that also drops a live thread from the cache.
      // The #315 idempotent repeat does NOT produce 400 (childless → 404;
      // with-replies → 200), so we never lose idempotency by excluding it here.
      if (status === 404) {
        const cache = queryClient.getQueryData(RQ_KEY(variables.pageId)) as
          | InfiniteData<IPagination<IComment>>
          | undefined;
        if (cache) {
          queryClient.setQueryData(
            RQ_KEY(variables.pageId),
            removeCommentFromCache(cache, variables.commentId),
          );
        }
        notifications.show({ message: t("Suggestion applied") });
        return;
      }
      // 400 => the thread was resolved and the edit could not be applied. Show a
      // real error and KEEP the comment in the cache (it is still alive). Prefer
      // the server's specific message when it carries one.
      if (status === 400) {
        const serverMsg = err?.response?.data?.message;
        notifications.show({
          message:
            typeof serverMsg === "string" && serverMsg.length > 0
              ? serverMsg
              : t("Failed to apply suggestion"),
          color: "red",
        });
        return;
      }
      // 409 => the commented text changed since the suggestion was made. Surface
      // a specific message (with the current text) rather than a generic error.
      const currentText = err?.response?.data?.currentText;
      if (status === 409 && typeof currentText === "string") {
        const shortText =
          currentText.length > 80
            ? `${currentText.slice(0, 80)}…`
            : currentText;
        notifications.show({
          title: t(
            "The commented text changed since this suggestion was made; it was not applied.",
          ),
          message: shortText,
          color: "red",
        });
        return;
      }
      notifications.show({
        message: t("Failed to apply suggestion"),
        color: "red",
      });
    },
  });
}

export function useDismissSuggestionMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation<
    ISuggestionOutcome,
    any,
    { commentId: string; pageId: string }
  >({
    mutationFn: ({ commentId }) => dismissSuggestion(commentId),
    onSuccess: (data, variables) => {
      // Ephemeral (#329): dismiss hard-deletes the suggestion when the thread has
      // no replies ('deleted') or resolves it when it does ('resolved').
      applySuggestionOutcomeToCache(
        queryClient,
        variables.pageId,
        variables.commentId,
        data,
      );

      notifications.show({ message: t("Suggestion dismissed") });
    },
    onError: (err: any, variables) => {
      // Idempotent race (double-click, or apply↔dismiss): the comment is already
      // gone (404). ONLY 404 is a real success-noop — drop it from the cache and
      // report success, the user's intent (make it disappear) is satisfied.
      //
      // 400 is NOT success (#338 F2): it means the thread is still ALIVE (already
      // resolved, or a reply raced in), so treating it as "dismissed" would drop
      // a live thread from the cache. Show a real error and keep the comment.
      const status = err?.response?.status;
      if (status === 404) {
        const cache = queryClient.getQueryData(RQ_KEY(variables.pageId)) as
          | InfiniteData<IPagination<IComment>>
          | undefined;
        if (cache) {
          queryClient.setQueryData(
            RQ_KEY(variables.pageId),
            removeCommentFromCache(cache, variables.commentId),
          );
        }
        notifications.show({ message: t("Suggestion dismissed") });
        return;
      }
      notifications.show({
        message: t("Failed to dismiss suggestion"),
        color: "red",
      });
    },
  });
}

export function useResolveCommentMutation() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: (data: IResolveComment) => resolveComment(data),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: RQ_KEY(variables.pageId) });
      const previousCache = queryClient.getQueryData(RQ_KEY(variables.pageId));

      const cache = previousCache as
        | InfiniteData<IPagination<IComment>>
        | undefined;
      if (cache) {
        queryClient.setQueryData(
          RQ_KEY(variables.pageId),
          updateCommentInCache(cache, variables.commentId, (comment) => ({
            ...comment,
            resolvedAt: variables.resolved ? new Date() : null,
            resolvedById: variables.resolved ? "optimistic" : null,
            resolvedBy: variables.resolved
              ? ({ id: "optimistic", name: "", avatarUrl: null } as IComment["resolvedBy"])
              : null,
          })),
        );
      }

      return { previousCache };
    },
    onError: (_err, variables, context) => {
      if (context?.previousCache) {
        queryClient.setQueryData(
          RQ_KEY(variables.pageId),
          context.previousCache,
        );
      }
      notifications.show({
        message: t("Failed to resolve comment"),
        color: "red",
      });
    },
    onSuccess: (data: IComment, variables) => {
      const cache = queryClient.getQueryData(
        RQ_KEY(data.pageId),
      ) as InfiniteData<IPagination<IComment>> | undefined;

      if (cache) {
        queryClient.setQueryData(
          RQ_KEY(data.pageId),
          updateCommentInCache(cache, variables.commentId, (comment) => ({
            ...comment,
            resolvedAt: data.resolvedAt,
            resolvedById: data.resolvedById,
            resolvedBy: data.resolvedBy,
          })),
        );
      }

      notifications.show({
        message: variables.resolved
          ? t("Comment resolved successfully")
          : t("Comment re-opened successfully"),
      });
    },
  });
}
