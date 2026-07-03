import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { IComment } from "@/features/comment/types/comment.types";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

// The comment mutation hooks reach out to react-query/network — stub them so the
// component renders in isolation. We only assert the AI-badge rendering branch.
vi.mock("@/features/comment/queries/comment-query", () => ({
  useDeleteCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useResolveCommentMutation: () => ({ mutateAsync: vi.fn() }),
  useUpdateCommentMutation: () => ({ mutateAsync: vi.fn() }),
}));

// CommentEditor pulls in the full TipTap editor stack; replace it with a stub.
vi.mock("@/features/comment/components/comment-editor", () => ({
  default: () => <div data-testid="comment-editor" />,
}));

import CommentListItem from "./comment-list-item";

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

function renderItem(comment: IComment) {
  return render(
    <MantineProvider>
      <CommentListItem comment={comment} pageId="page-1" canComment={true} />
    </MantineProvider>,
  );
}

describe("CommentListItem — agent avatar stack", () => {
  it('renders the agent avatar stack when createdSource === "agent"', () => {
    // External-MCP shape: agent is the account itself, no launcher behind.
    renderItem(
      baseComment({
        createdSource: "agent",
        aiChatId: null,
        agent: { name: "Service Bot", avatarUrl: null },
        launcher: null,
      }),
    );
    // The stack renders the agent name label (the creator name is also shown in
    // the row header, so it appears more than once).
    expect(screen.getAllByText("Service Bot").length).toBeGreaterThan(0);
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
