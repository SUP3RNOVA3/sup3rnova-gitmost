import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// The suggestion mutations reach react-query/network — stub them so the card
// renders in isolation. We assert the Apply/Dismiss gating and that the click
// hands the {commentId, pageId} pair to the existing mutation unchanged.
const applyMutateAsync = vi.fn();
const dismissMutateAsync = vi.fn();
vi.mock("@/features/comment/queries/comment-query", () => ({
  useApplySuggestionMutation: () => ({
    mutateAsync: applyMutateAsync,
    isPending: false,
  }),
  useDismissSuggestionMutation: () => ({
    mutateAsync: dismissMutateAsync,
    isPending: false,
  }),
}));

// CommentContentView -> mention-view -> page-query/share-query pull in the app
// entry (createRoot) as a side effect; stub the queries so the card renders in
// isolation.
vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useSharePageQuery: () => ({ data: undefined }),
}));
// space-query.ts -> main.tsx (createRoot) is a module side effect reached via the
// mention view; stub it so importing the card is side-effect free.
vi.mock("@/features/space/queries/space-query.ts", () => ({
  useSpaceQuery: () => ({ data: undefined }),
  useGetSpaceBySlugQuery: () => ({ data: undefined }),
}));

import AgentEditCard from "./agent-edit-card";

const body = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

const edit = (over?: Partial<IComment>): IComment =>
  ({
    id: "c-1",
    content: body("[Существенно] tighten the wording"),
    creatorId: "user-1",
    pageId: "page-1",
    workspaceId: "ws-1",
    createdAt: new Date(),
    createdSource: "agent",
    aiChatId: "chat-1",
    agent: { name: "Corrector", emoji: "✏️", avatarUrl: null },
    launcher: { name: "Alice", avatarUrl: null },
    creator: { id: "user-1", name: "Corrector", avatarUrl: null } as any,
    selection: "old wording here",
    suggestedText: "new wording here",
    ...over,
  }) as IComment;

function renderCard(
  comment: IComment,
  canEdit = true,
  canComment = true,
  userSpaceRole?: string,
) {
  return render(
    <MantineProvider>
      <AgentEditCard
        comment={comment}
        canComment={canComment}
        canEdit={canEdit}
        userSpaceRole={userSpaceRole}
      />
    </MantineProvider>,
  );
}

describe("AgentEditCard — suggested edit diff + Apply (#315)", () => {
  it("renders the было→стало diff and an Apply button when canEdit, not applied/resolved", () => {
    const { container } = renderCard(edit(), true);
    // Both diff lines are present (old struck-through, new added).
    expect(container.textContent).toContain("old wording here");
    expect(container.textContent).toContain("new wording here");
    // Diff line signs (aria-hidden) present for a replacement.
    expect(container.textContent).toContain("−");
    expect(container.textContent).toContain("+");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
  });

  it("hides Apply when canEdit is false (still shows the diff)", () => {
    const { container } = renderCard(edit(), false);
    expect(container.textContent).toContain("new wording here");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("hides Apply once the thread is resolved", () => {
    renderCard(edit({ resolvedAt: new Date() }), true);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("hides Apply once suggestionAppliedAt is set", () => {
    renderCard(edit({ suggestionAppliedAt: new Date() }), true);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("calls the apply mutation with {commentId, pageId} on click", () => {
    applyMutateAsync.mockClear();
    renderCard(edit(), true);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(applyMutateAsync).toHaveBeenCalledWith({
      commentId: "c-1",
      pageId: "page-1",
    });
  });

  it("a pure insertion (empty selection) hides the removed line", () => {
    const { container } = renderCard(
      edit({ selection: "", suggestedText: "added text" }),
      true,
    );
    // No "−" del sign — nothing was removed.
    expect(container.textContent).not.toContain("−");
    expect(container.textContent).toContain("+");
  });

  it("a pure deletion (empty suggestedText) hides the added line", () => {
    const { container } = renderCard(
      edit({ selection: "removed text", suggestedText: "" }),
      true,
    );
    expect(container.textContent).not.toContain("+");
    expect(container.textContent).toContain("−");
  });
});

describe("AgentEditCard — Dismiss gate (#329/#338)", () => {
  it("shows Dismiss alongside Apply for an admin who can edit/comment", () => {
    renderCard(edit(), true, true, "admin");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("shows Dismiss but NOT Apply for an admin commenter who cannot edit", () => {
    renderCard(edit(), false, true, "admin");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("hides Dismiss for a non-owner non-admin (mirrors server 403, #338 F5)", () => {
    renderCard(edit(), false, true, "member");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("hides Dismiss when the viewer cannot comment", () => {
    renderCard(edit(), false, false, "admin");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("calls the dismiss mutation with {commentId, pageId} on click", () => {
    dismissMutateAsync.mockClear();
    renderCard(edit(), true, true, "admin");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissMutateAsync).toHaveBeenCalledWith({
      commentId: "c-1",
      pageId: "page-1",
    });
  });
});

describe("AgentEditCard — provenance", () => {
  it("renders the agent avatar stack (provenance) for the edit author (#300)", () => {
    renderCard(edit(), true);
    // The agent role name is shown by the provenance stack.
    expect(screen.getAllByText("Corrector").length).toBeGreaterThan(0);
  });

  // The owner-or-admin gate uses the currentUser atom; clear localStorage so a
  // previous test's seed never leaks into the non-owner assertions above.
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());
});
