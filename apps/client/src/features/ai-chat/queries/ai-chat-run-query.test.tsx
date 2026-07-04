import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IAiChatRunResponse } from "@/features/ai-chat/types/ai-chat.types.ts";

// react-i18next is pulled in transitively by ai-chat-query.ts (the mutation hooks
// use it); stub it so the module imports cleanly in this hook test.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

// Mock the whole service module; only getAiChatRun is exercised here, but the
// other named exports must exist so ai-chat-query.ts imports resolve.
vi.mock("@/features/ai-chat/services/ai-chat-service.ts", () => ({
  getAiChatRun: vi.fn(),
  getAiChatMessages: vi.fn(),
  getAiChats: vi.fn(),
  getAiRoleCatalog: vi.fn(),
  getAiRoleCatalogBundle: vi.fn(),
  getAiRoles: vi.fn(),
  importAiRolesFromCatalog: vi.fn(),
  createAiRole: vi.fn(),
  deleteAiChat: vi.fn(),
  deleteAiRole: vi.fn(),
  renameAiChat: vi.fn(),
  updateAiRole: vi.fn(),
  updateAiRoleFromCatalog: vi.fn(),
}));

import { getAiChatRun } from "@/features/ai-chat/services/ai-chat-service.ts";
import { useAiChatRunQuery } from "@/features/ai-chat/queries/ai-chat-query.ts";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

const runningResponse: IAiChatRunResponse = {
  run: { id: "run-1", chatId: "c1", status: "running" },
  message: {
    id: "a1",
    role: "assistant",
    content: "working...",
    createdAt: "2026-01-01T00:00:00Z",
  },
};

describe("useAiChatRunQuery — enable gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the run when enabled (passive observer, feature on)", async () => {
    vi.mocked(getAiChatRun).mockResolvedValue(runningResponse);
    const { result } = renderHook(() => useAiChatRunQuery("c1", true), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getAiChatRun).toHaveBeenCalledWith("c1");
    expect(result.current.data?.run?.status).toBe("running");
  });

  it("does NOT fetch when disabled (this tab is the streamer / feature off)", async () => {
    vi.mocked(getAiChatRun).mockResolvedValue(runningResponse);
    renderHook(() => useAiChatRunQuery("c1", false), {
      wrapper: createWrapper(),
    });
    // Give any errant fetch a chance to fire, then assert none did.
    await new Promise((r) => setTimeout(r, 20));
    expect(getAiChatRun).not.toHaveBeenCalled();
  });

  it("does NOT fetch when there is no chat id", async () => {
    vi.mocked(getAiChatRun).mockResolvedValue(runningResponse);
    renderHook(() => useAiChatRunQuery(undefined, true), {
      wrapper: createWrapper(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(getAiChatRun).not.toHaveBeenCalled();
  });
});
