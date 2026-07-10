import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import i18n from "@/i18n.ts";
import { hasAutoReloaded, markAutoReloaded } from "@/lib/reload-guard";
import { decideVersionAction } from "@/features/user/version-coherence";

// Dirty shell around the pure `decideVersionAction`: it reads globals
// (APP_VERSION, document.visibilityState), touches sessionStorage via the
// shared reload-guard, and drives the Mantine notification. Kept separate from
// the pure module so the decision stays unit-testable without a DOM.

// One fixed id so repeated app-version signals (e.g. every reconnect) update a
// single banner instead of stacking a new one each time.
const BANNER_ID = "app-version-reload";

// Module-level idempotency for the current tab-load: once a mismatch has been
// handled we don't re-arm the visibility listener or re-show the banner on
// subsequent app-version emits.
let handled = false;

// Read the build version baked into THIS bundle. The `typeof` guard avoids a
// ReferenceError where the `APP_VERSION` global is absent (e.g. under vitest,
// where Vite's `define` did not run) — an unknown client version makes the
// pure decision no-op (fail-safe).
function readClientVersion(): string {
  return (typeof APP_VERSION !== "undefined" ? APP_VERSION : "").trim();
}

// Perform the actual reload — but only after the shared one-shot flag is
// persisted. If the write fails (storage unavailable) we must NOT reload
// (mirrors the reactive chunk-load boundary's `catch → return`), and fall back
// to the manual banner so the user can still recover.
function performAutoReload(): void {
  if (!markAutoReloaded()) {
    showReloadBanner();
    return;
  }
  window.location.reload();
}

function showReloadBanner(): void {
  notifications.show({
    id: BANNER_ID,
    title: i18n.t("A new version is available"),
    message: (
      <Button size="xs" mt="xs" onClick={() => performAutoReload()}>
        {i18n.t("Update")}
      </Button>
    ),
    autoClose: false,
    withCloseButton: true,
  });
}

/**
 * Handle a server `app-version` announcement: compare it to this bundle's
 * version and, on a real mismatch, do a guarded reload.
 *
 * - hidden tab              → reload immediately (nobody is looking).
 * - visible tab             → show the banner AND self-reload the moment the
 *                             tab goes to the background (or on the button).
 * - auto-reload already used / storage error → banner only (no auto-reload),
 *   so there is at most one automatic reload per session (loop safety).
 */
export function triggerGuardedReload(
  rawServerVersion: string | undefined | null,
): void {
  const serverVersion = (rawServerVersion ?? "").trim();
  const clientVersion = readClientVersion();

  // A storage read error surfaces as autoReloadUsed=true → fail toward NOT
  // reloading (banner only).
  const autoReloadUsed = hasAutoReloaded();

  const action = decideVersionAction({
    serverVersion,
    clientVersion,
    autoReloadUsed,
  });
  if (action === "noop") return;

  // Idempotent per tab-load: don't stack banners or re-arm the listener across
  // repeated emits (reconnects) once we've already acted.
  if (handled) return;
  handled = true;

  if (action === "banner") {
    // Entered banner-only (permanent skew, node oscillation, or spent
    // auto-reload). Log for diagnosability; show the manual banner.
    console.warn(
      `[version-coherence] server=${serverVersion} client=${clientVersion}: ` +
        "auto-reload already spent this session — showing manual banner",
    );
    showReloadBanner();
    return;
  }

  // action === "reload"
  if (document.visibilityState === "hidden") {
    // Covers tabs that are already backgrounded at the moment the signal
    // arrives — reload them right away.
    performAutoReload();
    return;
  }

  showReloadBanner();
  const onHidden = () => {
    if (document.visibilityState === "hidden") performAutoReload();
  };
  document.addEventListener("visibilitychange", onHidden, { once: true });
}

// Test-only: reset the module-level idempotency latch between cases.
export function __resetGuardedReloadForTests(): void {
  handled = false;
}
