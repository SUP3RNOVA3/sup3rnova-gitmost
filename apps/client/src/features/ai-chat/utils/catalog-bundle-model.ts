import type {
  IAiRole,
  IAiRoleCatalogRole,
} from "@/features/ai-chat/types/ai-chat.types.ts";
import { catalogRoleInstallState } from "@/features/ai-chat/utils/catalog-role-install-state.ts";

/**
 * The redesigned catalog modal renders bundles as cards with a summary status
 * (readable without expanding) and a single primary action. The per-role and
 * per-bundle view model that drives that UI is derived here as PURE functions so
 * the mapping, the "installed in another language" hint, and the bundle-phase
 * computation are unit-testable without mounting the component (mirrors the
 * `catalogRoleInstallState` precedent).
 */

/**
 * A role's status in the catalog view model.
 *  - `import`    — not installed in the current content language.
 *  - `installed` — installed and up to date.
 *  - `update`    — installed, but the catalog ships a newer version.
 *  - `skipped`   — TRANSIENT client-only status set after a conflicted import
 *                  (a name collision under `conflict:'skip'`); never from the
 *                  backend.
 */
export type RoleStatus = "import" | "installed" | "update" | "skipped";

/** A catalog role mapped into the modal's view model. */
export interface CatalogViewRole {
  // Slug is the stable identity within a bundle; used as the row key and as the
  // `slugs[]` payload for import.
  slug: string;
  // Optional in the catalog — the row reserves space and renders nothing when
  // absent.
  emoji?: string;
  name: string;
  description: string;
  // For `installed`/`import`: the catalog version. For `update`: the installed
  // (from) version, with `newVersion` holding the catalog (to) version.
  version: number;
  newVersion?: number;
  status: RoleStatus;
  // The language a same-slug role is installed under, when it differs from the
  // current content language (drives the Р5 hint). Only set for `import` roles.
  installedLang?: string;
  // The workspace role id, present for `installed`/`update` — needed to call the
  // update-from-catalog mutation.
  installedRoleId?: string;
}

/**
 * The summary phase of a bundle, derived from its roles' statuses. Determines
 * the collapsed-header summary and the bundle's single primary action.
 *  - `empty`        — the bundle has no roles.
 *  - `allNew`       — everything is importable, nothing installed.
 *  - `allInstalled` — nothing to import and nothing to update.
 *  - `updates`      — updates available and nothing left to import.
 *  - `mixed`        — any other combination.
 * Transient `skipped` roles are ignored (they count as neither import, installed
 * nor update), so a post-import conflict does not distort the header summary.
 */
export type BundlePhase =
  | "empty"
  | "allNew"
  | "allInstalled"
  | "updates"
  | "mixed";

export function bundlePhase(roles: CatalogViewRole[]): BundlePhase {
  if (roles.length === 0) return "empty";
  const imp = roles.filter((r) => r.status === "import").length;
  const ups = roles.filter((r) => r.status === "update").length;
  const installed = roles.filter((r) => r.status === "installed").length;
  if (imp === 0 && ups === 0) return "allInstalled";
  if (ups > 0 && imp === 0) return "updates";
  if (imp > 0 && installed === 0 && ups === 0) return "allNew";
  return "mixed";
}

/**
 * For a role NOT installed in the current `language`, find a workspace role with
 * the same catalog `slug` installed under a DIFFERENT language, and return that
 * language. Drives the "installed in another language" hint (Р5): a different
 * language of the same slug is a separate install and appears as `import`.
 */
export function installedLangForRole(
  slug: string,
  workspaceRoles: IAiRole[],
  language: string,
): string | undefined {
  const other = workspaceRoles.find(
    (r) =>
      r.source?.slug === slug &&
      !!r.source?.language &&
      r.source.language !== language,
  );
  return other?.source?.language;
}

/**
 * Map one catalog role to the view model, computing its install status against
 * the workspace roles (via `catalogRoleInstallState`) and, for importable roles,
 * the other-language hint.
 */
export function mapCatalogRoleToView(
  role: IAiRoleCatalogRole,
  workspaceRoles: IAiRole[],
  language: string,
): CatalogViewRole {
  const state = catalogRoleInstallState(role, workspaceRoles, language);
  const base = {
    slug: role.slug,
    emoji: role.emoji ?? undefined,
    name: role.name,
    description: role.description ?? "",
  };
  if (state.state === "update") {
    return {
      ...base,
      status: "update",
      version: state.fromVersion,
      newVersion: state.toVersion,
      installedRoleId: state.installed.id,
    };
  }
  if (state.state === "installed") {
    return {
      ...base,
      status: "installed",
      version: role.version,
      installedRoleId: state.installed.id,
    };
  }
  return {
    ...base,
    status: "import",
    version: role.version,
    installedLang: installedLangForRole(role.slug, workspaceRoles, language),
  };
}

/**
 * Map a whole bundle's catalog roles to the view model, preserving order.
 */
export function mapBundleRolesToView(
  roles: IAiRoleCatalogRole[],
  workspaceRoles: IAiRole[],
  language: string,
): CatalogViewRole[] {
  return roles.map((r) => mapCatalogRoleToView(r, workspaceRoles, language));
}
