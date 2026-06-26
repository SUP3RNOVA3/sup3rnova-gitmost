import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ContextBadge, formatTokens } from "./context-badge";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.
// Without an I18nextProvider, `t(key)` returns the key verbatim, so tooltip
// labels assert against their English source strings.

function renderBadge(props: {
  contextTokens: number;
  maxContextTokens?: number;
}) {
  return render(
    <MantineProvider>
      <ContextBadge {...props} />
    </MantineProvider>,
  );
}

describe("formatTokens", () => {
  it("formats with k / M suffixes", () => {
    expect(formatTokens(572)).toBe("572");
    expect(formatTokens(200_000)).toBe("200.0k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("ContextBadge", () => {
  it("shows `current / max` when a limit is configured", () => {
    renderBadge({ contextTokens: 572, maxContextTokens: 200_000 });
    expect(screen.getByText("572 / 200.0k")).toBeDefined();
  });

  it("shows only the current size when no limit is configured", () => {
    renderBadge({ contextTokens: 572, maxContextTokens: 0 });
    expect(screen.getByText("572")).toBeDefined();
    // No denominator rendered.
    expect(screen.queryByText(/\//)).toBeNull();
  });

  it("treats an undefined limit as no limit", () => {
    renderBadge({ contextTokens: 1234 });
    expect(screen.getByText("1.2k")).toBeDefined();
    expect(screen.queryByText(/\//)).toBeNull();
  });

  it("renders nothing until there is a current context size", () => {
    const { container } = renderBadge({
      contextTokens: 0,
      maxContextTokens: 200_000,
    });
    expect(container.querySelector("span")).toBeNull();
  });

  it("never flips to a live per-turn counter (no live mode); shows context as-is even above max", () => {
    // `current > max` (estimate drift / smaller-model role) is shown unclamped.
    renderBadge({ contextTokens: 210_000, maxContextTokens: 200_000 });
    expect(screen.getByText("210.0k / 200.0k")).toBeDefined();
  });

  it("exposes the limit tooltip label on hover", async () => {
    renderBadge({ contextTokens: 572, maxContextTokens: 200_000 });
    fireEvent.mouseEnter(screen.getByText("572 / 200.0k"));
    expect(
      await screen.findByText("Context size / model limit"),
    ).toBeDefined();
  });
});
