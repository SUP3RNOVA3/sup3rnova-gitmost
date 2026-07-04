import { describe, it, expect } from "vitest";
import { templateRoute } from "./route-template";

describe("templateRoute", () => {
  it("templates a space page path (never leaks slugs)", () => {
    const t = templateRoute("/s/engineering/p/design-doc-abc123");
    expect(t).toBe("/s/:space/p/:slug");
    expect(t).not.toContain("engineering");
    expect(t).not.toContain("design-doc");
  });

  it("templates share, redirect and space paths", () => {
    expect(templateRoute("/share/abc/p/xyz")).toBe("/share/:shareId/p/:slug");
    expect(templateRoute("/share/p/xyz")).toBe("/share/p/:slug");
    expect(templateRoute("/p/some-slug")).toBe("/p/:slug");
    expect(templateRoute("/s/team")).toBe("/s/:space");
    expect(templateRoute("/s/team/trash")).toBe("/s/:space/trash");
    expect(templateRoute("/labels/urgent")).toBe("/labels/:label");
  });

  it("keeps known static routes verbatim", () => {
    expect(templateRoute("/home")).toBe("/home");
    expect(templateRoute("/settings/members")).toBe("/settings/members");
    expect(templateRoute("/")).toBe("/");
  });

  it("normalises a trailing slash", () => {
    expect(templateRoute("/s/team/p/slug/")).toBe("/s/:space/p/:slug");
  });

  it("collapses unknown paths to 'other' (bounded cardinality)", () => {
    expect(templateRoute("/weird/unknown/thing")).toBe("other");
    expect(templateRoute("/s/team/p/slug/extra/segments")).toBe("other");
  });
});
