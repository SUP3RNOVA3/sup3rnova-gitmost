import { describe, it, expect } from "vitest";
import { dynamicIconImports } from "lucide-react/dynamic";
import { CURATED_ICON_NAMES } from "./curated-icons";

describe("CURATED_ICON_NAMES", () => {
  const valid = new Set(Object.keys(dynamicIconImports));

  it("every curated name is a real Lucide icon (key of dynamicIconImports)", () => {
    const missing = CURATED_ICON_NAMES.filter((n) => !valid.has(n));
    expect(missing).toEqual([]);
  });

  it("has no duplicates and stays within the picker window", () => {
    expect(new Set(CURATED_ICON_NAMES).size).toBe(CURATED_ICON_NAMES.length);
    expect(CURATED_ICON_NAMES.length).toBeGreaterThanOrEqual(60);
    expect(CURATED_ICON_NAMES.length).toBeLessThanOrEqual(120);
  });
});
