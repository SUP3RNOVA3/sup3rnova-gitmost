import { describe, it, expect } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PageIcon } from "./page-icon";
import { serializeIconRef } from "@/lib/icon-ref";

describe("PageIcon", () => {
  it("renders the default file glyph for a null value", () => {
    const { container } = render(<PageIcon value={null} />);
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).not.toBeNull();
  });

  it("renders the default file glyph for a legacy emoji value (never raw)", () => {
    const { container } = render(<PageIcon value="🚀" />);
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("🚀");
  });

  it("renders the default file glyph for malformed JSON", () => {
    const { container } = render(<PageIcon value={'{"name":'} />);
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("{");
  });

  it("renders a Lucide glyph in a colored box for a valid IconRef", async () => {
    const json = serializeIconRef({ name: "rocket", color: "teal" });
    const { container } = render(<PageIcon value={json} />);
    // The colored box exists and there is no default file glyph.
    expect(
      container.querySelector(".tabler-icon-file-description"),
    ).toBeNull();
    await waitFor(() => {
      expect(container.querySelector("svg")).not.toBeNull();
    });
    // No raw JSON ever reaches the DOM.
    expect(container.textContent ?? "").not.toContain('{"name"');
  });
});
