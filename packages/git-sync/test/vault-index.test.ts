import { describe, it, expect } from "vitest";
import {
  emptyVaultIndex,
  parseVaultIndex,
  serializeVaultIndex,
  pageIdAt,
  slugIdAt,
  pathForPageId,
  trackedPageIds,
  setEntry,
  removeAt,
  moveEntry,
} from "../src/engine/vault-index";

describe("vault-index parse/serialize", () => {
  it("round-trips a populated index", () => {
    const idx = emptyVaultIndex("sp1");
    setEntry(idx, "Проект/index.md", { pageId: "p1", slugId: "Ab12" });
    setEntry(idx, "Заметка.md", { pageId: "p2" });
    const text = serializeVaultIndex(idx);
    const back = parseVaultIndex(text);
    expect(back.spaceId).toBe("sp1");
    expect(pageIdAt(back, "Проект/index.md")).toBe("p1");
    expect(slugIdAt(back, "Проект/index.md")).toBe("Ab12");
    expect(pageIdAt(back, "Заметка.md")).toBe("p2");
    expect(slugIdAt(back, "Заметка.md")).toBeUndefined();
  });

  it("serializes deterministically (sorted keys -> stable diffs)", () => {
    const a = emptyVaultIndex("s");
    setEntry(a, "b.md", { pageId: "2" });
    setEntry(a, "a.md", { pageId: "1" });
    const b = emptyVaultIndex("s");
    setEntry(b, "a.md", { pageId: "1" });
    setEntry(b, "b.md", { pageId: "2" });
    // insertion order differs; serialized output must be identical.
    expect(serializeVaultIndex(a)).toBe(serializeVaultIndex(b));
    // keys are sorted in the output
    expect(serializeVaultIndex(a).indexOf('"a.md"')).toBeLessThan(
      serializeVaultIndex(a).indexOf('"b.md"'),
    );
  });

  it("is tolerant: null / garbage / bad entries -> empty or skipped", () => {
    expect(parseVaultIndex(null).pages.size).toBe(0);
    expect(parseVaultIndex("").pages.size).toBe(0);
    expect(parseVaultIndex("not json{").pages.size).toBe(0);
    expect(parseVaultIndex("[1,2,3]").pages.size).toBe(0);
    // a page entry missing pageId is skipped, valid ones kept
    const idx = parseVaultIndex(
      JSON.stringify({ version: 1, pages: { "ok.md": { pageId: "p" }, "bad.md": { slugId: "x" } } }),
    );
    expect(idx.pages.size).toBe(1);
    expect(pageIdAt(idx, "ok.md")).toBe("p");
  });
});

describe("vault-index lookups + mutations", () => {
  it("reverse lookup + tracked set", () => {
    const idx = emptyVaultIndex();
    setEntry(idx, "x.md", { pageId: "px" });
    setEntry(idx, "y/index.md", { pageId: "py" });
    expect(pathForPageId(idx, "py")).toBe("y/index.md");
    expect(pathForPageId(idx, "missing")).toBeUndefined();
    expect([...trackedPageIds(idx)].sort()).toEqual(["px", "py"]);
  });

  it("moveEntry relocates identity; removeAt drops it", () => {
    const idx = emptyVaultIndex();
    setEntry(idx, "Old.md", { pageId: "p", slugId: "s" });
    moveEntry(idx, "Old.md", "New/index.md");
    expect(pageIdAt(idx, "Old.md")).toBeUndefined();
    expect(pageIdAt(idx, "New/index.md")).toBe("p");
    expect(slugIdAt(idx, "New/index.md")).toBe("s"); // identity preserved
    removeAt(idx, "New/index.md");
    expect(pageIdAt(idx, "New/index.md")).toBeUndefined();
  });
});
