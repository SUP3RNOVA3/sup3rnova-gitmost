import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import catalog from "./lucide-catalog.generated";
import { loadIconModel } from "../../../../scripts/lucide-imports.mjs";
import { CATEGORY_TITLES } from "./lucide-categories";
import { CURATED_ICON_NAMES } from "./curated-icons";
import degradedAllowlist from "./lucide-catalog.degraded-allowlist.json";

// Guard test for the committed catalog artifact (issue #696). It FAILS the build
// on any drift between the artifact and the INSTALLED lucide-react — a bump
// without regeneration, a hand-edited version, a removed icon — and on a
// non-empty `degraded` that is not a deliberate, allow-listed offline release.
// Replaces the former curated-icons.test.ts (its check lives on as #5 below).
describe("lucide-catalog.generated", () => {
  const require = createRequire(import.meta.url);
  const installedVersion: string = require("lucide-react/package.json").version;
  const model = loadIconModel(import.meta.url);
  const canonical = [...model.canonical].sort();
  const aliasKeys = Object.keys(model.aliases).sort();

  const sorted = (a: string[]) => [...a].sort();

  it("1. catalog.v is the INSTALLED lucide-react version", () => {
    expect(catalog.v).toBe(installedVersion);
  });

  it("2. icons/tags/primary key sets equal the canonical set", () => {
    expect(sorted(Object.keys(catalog.icons))).toEqual(canonical);
    expect(sorted(Object.keys(catalog.tags))).toEqual(canonical);
    expect(sorted(Object.keys(catalog.primary))).toEqual(canonical);
  });

  it("3. aliases equal the derived alias set; every target is a canonical icon", () => {
    expect(sorted(Object.keys(catalog.aliases))).toEqual(aliasKeys);
    const iconKeys = new Set(Object.keys(catalog.icons));
    for (const [alias, target] of Object.entries(catalog.aliases)) {
      expect(iconKeys.has(target), `${alias} → ${target}`).toBe(true);
    }
  });

  it("4. every primary category slug has a title", () => {
    for (const slug of new Set(Object.values(catalog.primary))) {
      expect(CATEGORY_TITLES[slug], `missing title for "${slug}"`).toBeTruthy();
    }
  });

  it("5. every curated name is a canonical icon (NOT an alias)", () => {
    const iconKeys = new Set(Object.keys(catalog.icons));
    const missing = CURATED_ICON_NAMES.filter((n) => !iconKeys.has(n));
    expect(missing).toEqual([]);
    expect(new Set(CURATED_ICON_NAMES).size).toBe(CURATED_ICON_NAMES.length);
  });

  it("6. every icon has tags and a primary slug present (empty tags / 'other' ok)", () => {
    for (const name of Object.keys(catalog.icons)) {
      expect(Array.isArray(catalog.tags[name]), `tags[${name}]`).toBe(true);
      expect(typeof catalog.primary[name], `primary[${name}]`).toBe("string");
    }
  });

  it("7. degraded is empty, or exactly the deliberate offline allowlist", () => {
    expect(sorted(catalog.degraded)).toEqual(sorted(degradedAllowlist as string[]));
  });
});
