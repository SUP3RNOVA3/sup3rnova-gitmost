import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

// Capture the options ChatThread passes to useChat so the test can drive the
// hook's terminal callbacks (here: onError) directly, without a real stream. The
// box is created via vi.hoisted so the hoisted vi.mock factory below can close
// over it.
const { useChatBox } = vi.hoisted(() => ({
  useChatBox: { options: null as unknown as Record<string, unknown> | null },
}));

// Mock the AI SDK hook: record the options and return an inert, ready store so
// ChatThread renders without any network/streaming machinery.
vi.mock("@ai-sdk/react", () => ({
  useChat: (options: Record<string, unknown>) => {
    useChatBox.options = options;
    return {
      messages: [],
      sendMessage: vi.fn(),
      status: "ready",
      stop: vi.fn(),
      error: null,
    };
  },
}));

// Stub react-i18next so `t` returns the key (other component tests use the same
// pattern); ChatThread's rendered chrome is irrelevant to this wiring test.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Mock the heavy presentational children to trivial stubs — this test only
// exercises the onError → onTurnFinished wiring, not their rendering.
vi.mock("@/features/ai-chat/components/message-list.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/ai-chat/components/chat-input.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/ai-chat/components/role-cards.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/ai-chat/components/chat-error-alert.tsx", () => ({
  default: () => null,
}));
vi.mock("@/features/ai-chat/components/chat-stopped-notice.tsx", () => ({
  default: () => null,
}));

import ChatThread from "./chat-thread";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

describe("ChatThread onError wiring (#161)", () => {
  beforeEach(() => {
    useChatBox.options = null;
    vi.clearAllMocks();
  });

  it("onError calls onTurnFinished with (undefined, threadKey) so a late error from an abandoned thread is rejected", () => {
    const onTurnFinished = vi.fn();
    // Silence the deliberate console.error ChatThread logs for devtools.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <MantineProvider>
        <ChatThread
          chatId="c1"
          onTurnFinished={onTurnFinished}
          threadKey="thread-key-1"
        />
      </MantineProvider>,
    );

    const options = useChatBox.options;
    expect(options).not.toBeNull();
    expect(typeof options?.onError).toBe("function");

    // Drive the captured onError exactly as the AI SDK would on a stream error.
    act(() => {
      (options!.onError as (e: Error) => void)(new Error("stream blew up"));
    });

    // The thread's own mount key must be forwarded with NO server id, so the
    // session hook can reject this finish if the thread has been abandoned.
    expect(onTurnFinished).toHaveBeenCalledWith(undefined, "thread-key-1");

    consoleError.mockRestore();
  });
});
