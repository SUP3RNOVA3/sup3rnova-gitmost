/**
 * Branded page-identity types for the MCP client (incident family #435).
 *
 * A Docmost page has TWO identities that are BOTH plain strings:
 *   - the internal `page.id`  — a canonical UUID (the server generates UUIDv7),
 *   - the public `slugId`     — a 10-char nanoid over [0-9A-Za-z] used in URLs.
 * Because both are bare `string`s, they were passed around interchangeably and
 * silently swapped (e.g. locking/keying a collab doc by the slugId instead of
 * the UUID — the #260 data-loss). Branding them as distinct nominal types makes
 * a swap a COMPILE error at the seams that matter, and the validating
 * constructors reject a malformed / cross-wired identity at runtime too.
 *
 * These are type-level + format-validation helpers ONLY: a `PageId`/`SlugId` is
 * still a `string` at runtime (assignable INTO any `string` parameter with no
 * change), so branding a value flows outward for free; only the few seams that
 * REQUIRE a canonical id (resolvePageId's result, the per-page lock key, the
 * collab write entrypoints) demand the brand and so catch an unresolved raw id.
 */
import { UUID_RE } from "./page-lock.js";

/** The internal canonical page id (`page.id`), a canonical UUID. */
export type PageId = string & { readonly __brand: "PageId" };

/** The public page slug id (`slugId`), a 10-char nanoid used in URLs. */
export type SlugId = string & { readonly __brand: "SlugId" };

/**
 * A page REFERENCE an agent may supply: EITHER the canonical UUID `PageId` or
 * the public `SlugId`. The server's page lookup accepts both (a non-UUID is
 * matched as a slugId), so the public read/tool boundary legitimately takes
 * either form; only the resolved-to-canonical value is a strict `PageId`.
 */
export type PageRef = PageId | SlugId;

// A slugId is exactly 10 chars from the nanoid alphabet the server uses for
// generateSlugId: [0-9A-Za-z] (see apps/server .../common/helpers/nanoid.utils).
// Disjoint from a UUID (which is 36 chars WITH dashes), so the two formats can
// never be confused for one another.
export const SLUG_ID_RE = /^[0-9A-Za-z]{10}$/;

/** Type guard: is `value` a canonical page UUID (`PageId`)? */
export function isPageId(value: unknown): value is PageId {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Type guard: is `value` a public slug id (`SlugId`)? */
export function isSlugId(value: unknown): value is SlugId {
  return typeof value === "string" && SLUG_ID_RE.test(value);
}

/**
 * Validate + brand a canonical page id. Throws an actionable error (BEFORE any
 * network use) when `value` is not a canonical UUID, so a slugId or garbage
 * cross-wired where the canonical id is required fails fast and loud instead of
 * silently splitting a lock/doc key (#260). `label` names the offending param.
 */
export function asPageId(value: string, label = "pageId"): PageId {
  if (!isPageId(value)) {
    throw new Error(
      `${label}: expected a canonical page UUID (36 chars, e.g. ` +
        `019f499a-9f8c-7d68-b7be-ce100d7c6c56), got '${value}'. A slugId or ` +
        `other identity must be resolved to the page UUID first.`,
    );
  }
  return value;
}

/**
 * Validate + brand a public slug id. Throws when `value` is not the 10-char
 * slugId format, so a UUID or garbage cross-wired where a slugId is required is
 * rejected at the boundary.
 */
export function asSlugId(value: string, label = "slugId"): SlugId {
  if (!isSlugId(value)) {
    throw new Error(
      `${label}: expected a 10-char page slugId (e.g. 'aB3xQ7kR2p'), got ` +
        `'${value}'.`,
    );
  }
  return value;
}
