import { describe, it, expect } from "vitest";
import {
  bundlePhase,
  installedLangForRole,
  mapBundleRolesToView,
  mapCatalogRoleToView,
  type CatalogViewRole,
} from "./catalog-bundle-model.ts";
import type {
  IAiRole,
  IAiRoleCatalogRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";

function installedRole(
  source: { slug: string; language: string; version: number },
  overrides: Partial<IAiRole> = {},
): IAiRole {
  return {
    id: `role-${source.slug}-${source.language}`,
    name: source.slug,
    emoji: null,
    description: null,
    enabled: true,
    autoStart: true,
    launchMessage: null,
    source,
    ...overrides,
  };
}

function catalogRole(
  overrides: Partial<IAiRoleCatalogRole> = {},
): IAiRoleCatalogRole {
  return {
    slug: "writer",
    emoji: "✍️",
    name: "Writer",
    description: "Drafts copy.",
    instructions: "be a writer",
    autoStart: true,
    launchMessage: null,
    version: 3,
    ...overrides,
  };
}

// Build a minimal view role for bundlePhase tests.
function viewRole(status: CatalogViewRole["status"]): CatalogViewRole {
  return { slug: `s-${status}`, name: status, description: "", version: 1, status };
}

describe("bundlePhase", () => {
  it("empty bundle -> empty", () => {
    expect(bundlePhase([])).toBe("empty");
  });

  it("all importable, none installed -> allNew", () => {
    expect(bundlePhase([viewRole("import"), viewRole("import")])).toBe(
      "allNew",
    );
  });

  it("nothing to import or update -> allInstalled", () => {
    expect(bundlePhase([viewRole("installed"), viewRole("installed")])).toBe(
      "allInstalled",
    );
  });

  it("updates present, nothing to import -> updates", () => {
    expect(bundlePhase([viewRole("update"), viewRole("installed")])).toBe(
      "updates",
    );
  });

  it("import + installed (no updates) -> mixed", () => {
    expect(bundlePhase([viewRole("import"), viewRole("installed")])).toBe(
      "mixed",
    );
  });

  it("import + update -> mixed", () => {
    expect(bundlePhase([viewRole("import"), viewRole("update")])).toBe("mixed");
  });

  it("transient skipped roles are ignored (counted as neither) -> allInstalled", () => {
    expect(bundlePhase([viewRole("skipped")])).toBe("allInstalled");
  });
});

describe("installedLangForRole", () => {
  it("returns the other language when the same slug is installed elsewhere", () => {
    const roles = [installedRole({ slug: "writer", language: "ru", version: 2 })];
    expect(installedLangForRole("writer", roles, "en")).toBe("ru");
  });

  it("returns undefined when the same slug is installed in the SAME language", () => {
    const roles = [installedRole({ slug: "writer", language: "en", version: 2 })];
    expect(installedLangForRole("writer", roles, "en")).toBeUndefined();
  });

  it("returns undefined when no install of the slug exists", () => {
    expect(installedLangForRole("writer", [], "en")).toBeUndefined();
  });

  it("ignores manually-created roles (no source)", () => {
    const roles = [
      installedRole({ slug: "writer", language: "ru", version: 2 }, {
        source: null,
      }),
    ];
    expect(installedLangForRole("writer", roles, "en")).toBeUndefined();
  });
});

describe("mapCatalogRoleToView", () => {
  it("no install -> import status, catalog version, emoji preserved", () => {
    const view = mapCatalogRoleToView(catalogRole(), [], "en");
    expect(view).toMatchObject({
      slug: "writer",
      emoji: "✍️",
      name: "Writer",
      description: "Drafts copy.",
      status: "import",
      version: 3,
    });
    expect(view.installedRoleId).toBeUndefined();
    expect(view.installedLang).toBeUndefined();
  });

  it("import with the slug installed in another language -> installedLang set", () => {
    const roles = [installedRole({ slug: "writer", language: "ru", version: 9 })];
    const view = mapCatalogRoleToView(catalogRole(), roles, "en");
    expect(view.status).toBe("import");
    expect(view.installedLang).toBe("ru");
  });

  it("installed (up to date) -> installed status, catalog version, installedRoleId", () => {
    const installed = installedRole({
      slug: "writer",
      language: "en",
      version: 3,
    });
    const view = mapCatalogRoleToView(catalogRole(), [installed], "en");
    expect(view).toMatchObject({
      status: "installed",
      version: 3,
      installedRoleId: installed.id,
    });
  });

  it("update -> version=from, newVersion=to, installedRoleId", () => {
    const installed = installedRole({
      slug: "writer",
      language: "en",
      version: 1,
    });
    const view = mapCatalogRoleToView(catalogRole(), [installed], "en");
    expect(view).toMatchObject({
      status: "update",
      version: 1,
      newVersion: 3,
      installedRoleId: installed.id,
    });
  });

  it("missing emoji -> emoji undefined; null description -> empty string", () => {
    const view = mapCatalogRoleToView(
      catalogRole({ emoji: null, description: null }),
      [],
      "en",
    );
    expect(view.emoji).toBeUndefined();
    expect(view.description).toBe("");
  });
});

describe("mapBundleRolesToView", () => {
  it("maps a bundle's roles preserving order", () => {
    const roles = [
      catalogRole({ slug: "a", name: "A", version: 1 }),
      catalogRole({ slug: "b", name: "B", version: 1 }),
    ];
    const installed = [installedRole({ slug: "a", language: "en", version: 1 })];
    const view = mapBundleRolesToView(roles, installed, "en");
    expect(view.map((r) => r.slug)).toEqual(["a", "b"]);
    expect(view[0].status).toBe("installed");
    expect(view[1].status).toBe("import");
  });
});
