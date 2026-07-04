import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// The comment mutation hooks reach out to react-query/network — stub them so the
// component renders in isolation. We only assert the AI-badge rendering branch.
const applyMutateAsync = vi.fn();
const dismissMutateAsync = vi.fn();
vi.mock("@/features/comment/queries/comment-query", () => ({
  useDeleteCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useResolveCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useApplySuggestionMutation: () => ({
    mutateAsync: applyMutateAsync,
    isPending: false,
  }),
  useDismissSuggestionMutation: () => ({
    mutateAsync: dismissMutateAsync,
    isPending: false,
  }),
}));

// CommentEditor pulls in the full TipTap editor stack; replace it with a stub.
vi.mock("@/features/comment/components/comment-editor", () => ({
  default: () => <div data-testid="comment-editor" />,
}));

// CommentContentView (used for the read-only body) imports the mention view,
// which pulls page-query -> main.tsx (createRoot). Stub the queries so the item
// renders in isolation without the app entry side-effect.
vi.mock("@/features/page/queries/page-query.ts", () => ({
  usePageQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@/features/share/queries/share-query.ts", () => ({
  useSharePageQuery: () => ({ data: undefined }),
}));

import CommentListItem from "./comment-list-item";
import {
  canShowApply,
  canShowDismiss,
} from "@/features/comment/utils/suggestion";

const baseComment = (over?: Partial<IComment>): IComment =>
  ({
    id: "c-1",
    content: JSON.stringify({ type: "doc", content: [] }),
    creatorId: "user-1",
    pageId: "page-1",
    workspaceId: "ws-1",
    createdAt: new Date(),
    creator: { id: "user-1", name: "Service Bot", avatarUrl: null } as any,
    ...over,
  }) as IComment;

function renderItem(
  comment: IComment,
  canEdit = true,
  canComment = true,
  userSpaceRole?: string,
) {
  return render(
    <MantineProvider>
      <CommentListItem
        comment={comment}
        pageId="page-1"
        canComment={canComment}
        canEdit={canEdit}
        userSpaceRole={userSpaceRole}
      />
    </MantineProvider>,
  );
}

describe("CommentListItem — agent avatar stack", () => {
  it('flips the hierarchy for an agent comment: agent primary, launcher shown once', () => {
    // Internal-chat shape with DISTINCT names so absence-of-duplication is
    // assertable: creator is the human "Alice", the acting agent is "Researcher".
    renderItem(
      baseComment({
        creator: { id: "user-1", name: "Alice", avatarUrl: null } as any,
        createdSource: "agent",
        aiChatId: "chat-1",
        agent: { name: "Researcher", emoji: "🔬", avatarUrl: null },
        launcher: { name: "Alice", avatarUrl: null },
      }),
    );
    // The AGENT is the primary label (the flipped hierarchy).
    expect(screen.getByText("Researcher")).toBeDefined();
    // The human launcher name shows exactly once — it is no longer duplicated as
    // a separate creator name (that duplication is the bug this fixes).
    expect(screen.getAllByText("Alice").length).toBe(1);
  });

  it('external MCP agent comment (no launcher): shows the agent name, no separator', () => {
    // aiChatId null => external MCP: the agent IS the account, no human behind.
    renderItem(
      baseComment({
        creator: { id: "bot-1", name: "MCP Bot", avatarUrl: null } as any,
        createdSource: "agent",
        aiChatId: null,
        agent: { name: "MCP Bot", avatarUrl: null },
        launcher: null,
      }),
    );
    expect(screen.getByText("MCP Bot")).toBeDefined();
    // No launcher => no dimmed "·" separator in the header.
    expect(screen.queryByText("·")).toBeNull();
  });

  it('does NOT render the stack for a normal user comment (createdSource "user")', () => {
    const { container } = renderItem(baseComment({ createdSource: "user" }));
    // No agent glyph (sparkles) is present for a plain human comment.
    expect(container.querySelector(".tabler-icon-sparkles")).toBeNull();
    expect(screen.getByText("Service Bot")).toBeDefined();
  });

  // The stack's own behaviors (glyph priority, launcher-behind, deep-link click)
  // are covered directly in agent-avatar-stack.test.tsx; this integration suite
  // only guards the insertion gate (agent → stack, user → no stack).
});

describe("CommentListItem — suggested edit (#315)", () => {
  const suggestion = (over?: Partial<IComment>): IComment =>
    baseComment({
      selection: "old wording here",
      suggestedText: "new wording here",
      ...over,
    });

  it("renders the было→стало diff and an Apply button when canEdit and not applied/resolved", () => {
    const { container } = renderItem(suggestion(), true);
    // Old text appears as the selection quote (a single unsplit Text node).
    expect(screen.getAllByText("old wording here").length).toBeGreaterThan(0);
    // The new line is now rendered as per-fragment spans (intraline diff, #331),
    // so it is no longer a single text node — assert the concatenated content.
    expect(container.textContent).toContain("new wording here");
    // Apply button is present.
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
    // No Applied badge yet.
    expect(screen.queryByText("Applied")).toBeNull();
  });

  it("hides the Apply button when canEdit is false", () => {
    const { container } = renderItem(suggestion(), false);
    // Diff still renders (as per-fragment spans, #331)...
    expect(container.textContent).toContain("new wording here");
    // ...but no Apply button.
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("shows an Applied badge (no Apply button) once suggestionAppliedAt is set", () => {
    renderItem(suggestion({ suggestionAppliedAt: new Date() }), true);
    expect(screen.getByText("Applied")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("hides the Apply button once the thread is resolved", () => {
    renderItem(suggestion({ resolvedAt: new Date() }), true);
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("calls the apply mutation when the Apply button is clicked", () => {
    applyMutateAsync.mockClear();
    renderItem(suggestion(), true);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(applyMutateAsync).toHaveBeenCalledWith({
      commentId: "c-1",
      pageId: "page-1",
    });
  });

  it("does not render the diff block for a reply (child) comment", () => {
    renderItem(
      suggestion({ parentCommentId: "c-0" }),
      true,
    );
    expect(screen.queryByText("new wording here")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});

describe("CommentListItem — dismiss suggestion (#329)", () => {
  const suggestion = (over?: Partial<IComment>): IComment =>
    baseComment({
      selection: "old wording here",
      suggestedText: "new wording here",
      ...over,
    });

  // A space admin (userSpaceRole="admin") satisfies the owner-or-admin gate
  // regardless of who authored the comment; the tests below use it as the lever
  // since the currentUser atom is unseeded (null) in this harness.
  it("renders a Dismiss button alongside Apply when canEdit and canComment (owner/admin)", () => {
    renderItem(suggestion(), true, true, "admin");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("shows Dismiss but NOT Apply for an admin commenter who cannot edit", () => {
    renderItem(suggestion(), false, true, "admin");
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("hides Dismiss when the viewer cannot comment", () => {
    renderItem(suggestion(), false, false, "admin");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("hides Dismiss for a non-owner non-admin even with canComment (#338 F5: mirrors server 403)", () => {
    // canComment=true but NOT a space admin and NOT the comment owner (the
    // currentUser atom is null while the comment is authored by user-1), so the
    // server would 403 a dismiss — the button must not be shown at all.
    renderItem(suggestion(), false, true, "member");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("hides Dismiss once the thread is resolved", () => {
    renderItem(suggestion({ resolvedAt: new Date() }), true, true, "admin");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("hides Dismiss (shows the Applied badge) once applied", () => {
    renderItem(suggestion({ suggestionAppliedAt: new Date() }), true, true, "admin");
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.getByText("Applied")).toBeDefined();
  });

  it("calls the dismiss mutation when the Dismiss button is clicked", () => {
    dismissMutateAsync.mockClear();
    renderItem(suggestion(), true, true, "admin");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissMutateAsync).toHaveBeenCalledWith({
      commentId: "c-1",
      pageId: "page-1",
    });
  });
});

describe("canShowApply predicate", () => {
  const c = (over?: Partial<IComment>): IComment =>
    ({ suggestedText: "x", ...over }) as IComment;

  it("true when suggestion present, editable, not applied/resolved, top-level", () => {
    expect(canShowApply(c(), true)).toBe(true);
  });
  it("false without edit permission", () => {
    expect(canShowApply(c(), false)).toBe(false);
  });
  it("false when no suggestion", () => {
    expect(canShowApply(c({ suggestedText: null }), true)).toBe(false);
  });
  it("false when already applied", () => {
    expect(canShowApply(c({ suggestionAppliedAt: new Date() }), true)).toBe(
      false,
    );
  });
  it("false when resolved", () => {
    expect(canShowApply(c({ resolvedAt: new Date() }), true)).toBe(false);
  });
  it("false for a reply comment", () => {
    expect(canShowApply(c({ parentCommentId: "p" }), true)).toBe(false);
  });
});

describe("canShowDismiss predicate", () => {
  const c = (over?: Partial<IComment>): IComment =>
    ({ suggestedText: "x", ...over }) as IComment;

  it("true when suggestion present, can comment, owner/admin, not applied/resolved, top-level", () => {
    expect(canShowDismiss(c(), true, true)).toBe(true);
  });
  it("false without comment permission", () => {
    expect(canShowDismiss(c(), false, true)).toBe(false);
  });
  it("false when not owner and not admin (#338 F5)", () => {
    expect(canShowDismiss(c(), true, false)).toBe(false);
  });
  it("false when no suggestion", () => {
    expect(canShowDismiss(c({ suggestedText: null }), true, true)).toBe(false);
  });
  it("false when already applied", () => {
    expect(canShowDismiss(c({ suggestionAppliedAt: new Date() }), true, true)).toBe(
      false,
    );
  });
  it("false when resolved", () => {
    expect(canShowDismiss(c({ resolvedAt: new Date() }), true, true)).toBe(false);
  });
  it("false for a reply comment", () => {
    expect(canShowDismiss(c({ parentCommentId: "p" }), true, true)).toBe(false);
  });
});

describe("CommentListItem — read-only body renders statically", () => {
  it("renders the comment body as static text without a TipTap editor", () => {
    renderItem(
      baseComment({
        content: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Hello static world" }],
            },
          ],
        }),
      }),
    );
    // Body text is present...
    expect(screen.getByText("Hello static world")).toBeDefined();
    // ...and it did NOT go through the (mocked) CommentEditor instance.
    expect(screen.queryByTestId("comment-editor")).toBeNull();
  });
});
