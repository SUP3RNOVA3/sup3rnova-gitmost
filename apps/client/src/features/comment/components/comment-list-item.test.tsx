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
