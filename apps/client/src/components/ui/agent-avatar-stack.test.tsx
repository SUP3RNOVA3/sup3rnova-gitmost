import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { Provider, createStore } from "jotai";
import { AgentAvatarStack, agentGlyphBackground } from "./agent-avatar-stack";
import {
  activeAiChatIdAtom,
  aiChatWindowOpenAtom,
  aiChatDraftAtom,
} from "@/features/ai-chat/atoms/ai-chat-atom.ts";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

type Props = React.ComponentProps<typeof AgentAvatarStack>;

function renderStack(props: Props) {
  const store = createStore();
  store.set(aiChatDraftAtom, "leftover draft from another chat");
  const utils = render(
    <Provider store={store}>
      <MantineProvider>
        <AgentAvatarStack {...props} />
      </MantineProvider>
    </Provider>,
  );
  return { store, ...utils };
}

describe("agentGlyphBackground", () => {
  it("is deterministic for a given agent name", () => {
    expect(agentGlyphBackground("Researcher")).toBe(
      agentGlyphBackground("Researcher"),
    );
  });

  it("differs by name and stays a fixed dark shade (readable emoji)", () => {
    expect(agentGlyphBackground("Researcher")).not.toBe(
      agentGlyphBackground("Нарратор"),
    );
    // Only the hue varies; saturation/lightness are pinned low so the glyph is
    // always a dark circle.
    expect(agentGlyphBackground("Нарратор")).toMatch(/^hsl\(\d+, 45%, 24%\)$/);
  });
});

describe("AgentAvatarStack", () => {
  it("internal chat WITH role: emoji glyph in front + human launcher behind", () => {
    const { container } = renderStack({
      agent: { name: "Researcher", emoji: "🔬", avatarUrl: null },
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
    });

    // Emoji is used as the glyph (priority 2), NOT the sparkles fallback.
    expect(screen.getByText("🔬")).toBeDefined();
    expect(container.querySelector(".tabler-icon-sparkles")).toBeNull();
    // Label: bold role name + dimmed "· launcher".
    expect(screen.getByText("Researcher")).toBeDefined();
    expect(screen.getByText(/·/)).toBeDefined();
    expect(screen.getByText("Alice")).toBeDefined();
  });

  it("showName=false: renders only the avatars, no inline name label", () => {
    renderStack({
      agent: { name: "Researcher", emoji: "🔬", avatarUrl: null },
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
      showName: false,
    });

    // The agent glyph is still rendered...
    expect(screen.getByText("🔬")).toBeDefined();
    // ...but neither the agent NOR the launcher inline name label is rendered
    // (they live only in the hover tooltip, which is not mounted in the initial
    // DOM) — guards against suppressing only the agent name and leaking the
    // launcher name.
    expect(screen.queryByText("Researcher")).toBeNull();
    expect(screen.queryByText("Alice")).toBeNull();
  });

  it("internal chat WITHOUT role: sparkles fallback + 'AI agent' + launcher", () => {
    const { container } = renderStack({
      agent: { name: "AI agent", avatarUrl: null },
      launcher: { name: "Bob", avatarUrl: null },
      aiChatId: "chat-2",
    });

    // No avatarUrl and no emoji => sparkles glyph (priority 3).
    expect(container.querySelector(".tabler-icon-sparkles")).not.toBeNull();
    expect(screen.getByText("AI agent")).toBeDefined();
    expect(screen.getByText("Bob")).toBeDefined();
  });

  it("external MCP: agent avatar in front, NO launcher behind", () => {
    const { container } = renderStack({
      agent: { name: "MCP Bot", avatarUrl: "http://example.test/a.png" },
      launcher: null,
      aiChatId: null,
    });

    // avatarUrl provided (priority 1) => not the sparkles fallback.
    expect(container.querySelector(".tabler-icon-sparkles")).toBeNull();
    expect(screen.getByText("MCP Bot")).toBeDefined();
    // No human behind => no "·" separator is rendered.
    expect(screen.queryByText(/·/)).toBeNull();
    // No internal chat => the stack is not an interactive deep-link button.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("click deep-links into the chat when aiChatId is present", () => {
    const { store } = renderStack({
      agent: { name: "Researcher", emoji: "🔬", avatarUrl: null },
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
    });

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(store.get(activeAiChatIdAtom)).toBe("chat-1");
    expect(store.get(aiChatWindowOpenAtom)).toBe(true);
    expect(store.get(aiChatDraftAtom)).toBe(""); // draft cleared on switch
  });

  it("click is a no-op / not interactive without a chat target", () => {
    const onActivate = vi.fn();
    renderStack({
      agent: { name: "MCP Bot", avatarUrl: "http://example.test/a.png" },
      launcher: null,
      aiChatId: null,
      onActivate,
    });
    expect(screen.queryByRole("button")).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();
  });
});
