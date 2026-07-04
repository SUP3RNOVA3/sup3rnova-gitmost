import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  InfiniteData,
} from "@tanstack/react-query";

/**
 * Coverage for the ephemeral-suggestion (#329) cache reconciliation in
 * useApplySuggestionMutation / useDismissSuggestionMutation: the mutations act on
 * the server `outcome` — 'deleted' drops the comment from the local list,
 * 'resolved' relocates it (by stamping resolvedAt, which the tabs split on).
 */

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

vi.mock("@/features/comment/services/comment-service", () => ({
  applySuggestion: vi.fn(),
  dismissSuggestion: vi.fn(),
  createComment: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  resolveComment: vi.fn(),
  getPageComments: vi.fn(),
}));

import {
  applySuggestion,
  dismissSuggestion,
} from "@/features/comment/services/comment-service";
import {
  useApplySuggestionMutation,
  useDismissSuggestionMutation,
  RQ_KEY,
} from "@/features/comment/queries/comment-query";
import { IComment } from "@/features/comment/types/comment.types";

const PAGE_ID = "page-1";

function seededClient(comment: IComment) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const seed: InfiniteData<any> = {
    pageParams: [undefined],
    pages: [{ items: [comment], meta: { hasNextPage: false, nextCursor: null } }],
  };
  queryClient.setQueryData(RQ_KEY(PAGE_ID), seed);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function items(queryClient: QueryClient): IComment[] {
  const cache = queryClient.getQueryData(RQ_KEY(PAGE_ID)) as
    | InfiniteData<any>
    | undefined;
  return cache?.pages.flatMap((p) => p.items) ?? [];
}

const comment = (over?: Partial<IComment>): IComment =>
  ({
    id: "c-1",
    pageId: PAGE_ID,
    content: "{}",
    creatorId: "u-1",
    workspaceId: "ws-1",
    createdAt: new Date(),
    suggestedText: "new",
    ...over,
  }) as IComment;

describe("useApplySuggestionMutation — outcome handling (#329)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("outcome=deleted → removes the comment from the list", async () => {
    vi.mocked(applySuggestion).mockResolvedValue({
      id: "c-1",
      pageId: PAGE_ID,
      outcome: "deleted",
    } as any);
    const { queryClient, wrapper } = seededClient(comment());

    const { result } = renderHook(() => useApplySuggestionMutation(), {
      wrapper,
    });
    await result.current.mutateAsync({ commentId: "c-1", pageId: PAGE_ID });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(items(queryClient)).toHaveLength(0);
  });

  it("outcome=resolved → keeps the comment and stamps resolvedAt/applied fields", async () => {
    const resolvedAt = new Date();
    vi.mocked(applySuggestion).mockResolvedValue({
      id: "c-1",
      pageId: PAGE_ID,
      outcome: "resolved",
      resolvedAt,
      resolvedById: "u-1",
      resolvedBy: { id: "u-1", name: "A" },
      suggestionAppliedAt: resolvedAt,
      suggestionAppliedById: "u-1",
    } as any);
    const { queryClient, wrapper } = seededClient(comment());

    const { result } = renderHook(() => useApplySuggestionMutation(), {
      wrapper,
    });
    await result.current.mutateAsync({ commentId: "c-1", pageId: PAGE_ID });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const list = items(queryClient);
    expect(list).toHaveLength(1);
    expect(list[0].resolvedAt).toBe(resolvedAt);
    expect(list[0].suggestionAppliedAt).toBe(resolvedAt);
  });
});

describe("useDismissSuggestionMutation — outcome handling (#329)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("outcome=deleted → removes the comment from the list", async () => {
    vi.mocked(dismissSuggestion).mockResolvedValue({
      id: "c-1",
      pageId: PAGE_ID,
      outcome: "deleted",
    } as any);
    const { queryClient, wrapper } = seededClient(comment());

    const { result } = renderHook(() => useDismissSuggestionMutation(), {
      wrapper,
    });
    await result.current.mutateAsync({ commentId: "c-1", pageId: PAGE_ID });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(items(queryClient)).toHaveLength(0);
  });

  it("outcome=resolved → keeps the comment and stamps resolvedAt", async () => {
    const resolvedAt = new Date();
    vi.mocked(dismissSuggestion).mockResolvedValue({
      id: "c-1",
      pageId: PAGE_ID,
      outcome: "resolved",
      resolvedAt,
      resolvedById: "u-1",
      resolvedBy: { id: "u-1", name: "A" },
    } as any);
    const { queryClient, wrapper } = seededClient(comment());

    const { result } = renderHook(() => useDismissSuggestionMutation(), {
      wrapper,
    });
    await result.current.mutateAsync({ commentId: "c-1", pageId: PAGE_ID });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const list = items(queryClient);
    expect(list).toHaveLength(1);
    expect(list[0].resolvedAt).toBe(resolvedAt);
  });

  it("idempotent race (404) → treated as success, comment removed from the list", async () => {
    vi.mocked(dismissSuggestion).mockRejectedValue({
      response: { status: 404 },
    });
    const { queryClient, wrapper } = seededClient(comment());

    const { result } = renderHook(() => useDismissSuggestionMutation(), {
      wrapper,
    });
    // mutateAsync rejects even though onError reconciles the cache; swallow it.
    await result.current
      .mutateAsync({ commentId: "c-1", pageId: PAGE_ID })
      .catch(() => undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(items(queryClient)).toHaveLength(0);
  });

  it("APPLY idempotent race (404) → treated as success, comment removed from the list", async () => {
    // After #329 an applied reply-less suggestion is hard-deleted, so a racing
    // second apply hits 404 — must reconcile to success like dismiss, not a red
    // error (restores the #315 apply idempotency).
    vi.mocked(applySuggestion).mockRejectedValue({
      response: { status: 404 },
    });
    const { queryClient, wrapper } = seededClient(comment());

    const { result } = renderHook(() => useApplySuggestionMutation(), {
      wrapper,
    });
    await result.current
      .mutateAsync({ commentId: "c-1", pageId: PAGE_ID })
      .catch(() => undefined);
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(items(queryClient)).toHaveLength(0);
  });
});
