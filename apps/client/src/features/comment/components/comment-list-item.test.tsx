import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// The comment mutation hooks reach out to react-query/network — stub them so the
// component renders in isolation. We only assert the AI-badge rendering branch.
const applyMutateAsync = vi.fn();
vi.mock("@/features/comment/queries/comment-query", () => ({
  useDeleteCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useResolveCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useApplySuggestionMutation: () => ({
    mutateAsync: applyMutateAsync,
    isPending: false,
  }),
}));

// CommentEditor pulls in the full TipTap editor stack; replace it with a stub.
vi.mock("@/features/comment/components/comment-editor", () => ({
  default: () => <div data-testid="comment-editor" />,
}));

import CommentListItem from "./comment-list-item";
import { canShowApply } from "@/features/comment/utils/suggestion";

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

function renderItem(comment: IComment, canEdit = true) {
  return render(
    <MantineProvider>
      <CommentListItem
        comment={comment}
        pageId="page-1"
        canComment={true}
        canEdit={canEdit}
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
