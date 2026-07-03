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

// The DOM normalizes an inline `background: hsl(...)` to `rgb(...)`. Push the
// expected color through the same CSSOM path so the comparison stays exact and
// non-vacuous (an empty string — i.e. no inline background, as in the pre-fix
// Avatar approach — can never match a real color).
function normalizeColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.background = value;
  return probe.style.background;
}

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

  it("gives categorically different colors to different agents", () => {
    // The two agents that looked identically violet in the report must differ.
    expect(agentGlyphBackground("Структурный редактор")).not.toBe(
      agentGlyphBackground("Фактчекер"),
    );
    expect(agentGlyphBackground("Researcher")).not.toBe(
      agentGlyphBackground("Нарратор"),
    );
    // Every color is a dark hsl circle drawn from the palette.
    expect(agentGlyphBackground("Нарратор")).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
});

describe("AgentAvatarStack", () => {
  it("internal chat WITH role: emoji glyph + human launcher badge in front", () => {
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

  it("emoji glyph applies its per-agent color as an inline DOM background", () => {
    // Pins the actual fix: the hashed color must reach the DOM as an inline
    // `background` on the glyph Box. The pre-fix `Avatar variant="filled"` set no
    // inline background (Mantine's --avatar-bg overrode it), so this fails there.
    const agent = { name: "Researcher", emoji: "🔬", avatarUrl: null };
    const { container } = renderStack({
      agent,
      launcher: { name: "Alice", avatarUrl: null },
      aiChatId: "chat-1",
    });

    const glyph = container.querySelector<HTMLElement>(
      '[data-testid="agent-glyph"]',
    );
    expect(glyph).not.toBeNull();
    // Non-vacuous: compare against the function output (normalized the same way),
    // not a frozen literal. Empty against the pre-fix Avatar (no inline bg).
    expect(glyph!.style.background).not.toBe("");
    expect(glyph!.style.background).toBe(
      normalizeColor(agentGlyphBackground(agent.name)),
    );
  });

  it("agents with distinct hashed colors reach the DOM as distinct backgrounds", () => {
    // "Researcher" and "Нарратор" hash to different palette entries, so their
    // applied DOM backgrounds must differ — pins "distinct colors reach the DOM".
    expect(agentGlyphBackground("Researcher")).not.toBe(
      agentGlyphBackground("Нарратор"),
    );

    const a = renderStack({
      agent: { name: "Researcher", emoji: "🔬", avatarUrl: null },
      launcher: null,
      aiChatId: null,
    });
    const b = renderStack({
      agent: { name: "Нарратор", emoji: "📖", avatarUrl: null },
      launcher: null,
      aiChatId: null,
    });

    const glyphA = a.container.querySelector<HTMLElement>(
      '[data-testid="agent-glyph"]',
    );
    const glyphB = b.container.querySelector<HTMLElement>(
      '[data-testid="agent-glyph"]',
    );
    expect(glyphA!.style.background).toBe(
      normalizeColor(agentGlyphBackground("Researcher")),
    );
    expect(glyphB!.style.background).toBe(
      normalizeColor(agentGlyphBackground("Нарратор")),
    );
    // Different colors reach the DOM (the normalized rgb values also differ).
    expect(glyphA!.style.background).not.toBe(glyphB!.style.background);
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

  it("external MCP: agent avatar only, NO human launcher badge", () => {
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
