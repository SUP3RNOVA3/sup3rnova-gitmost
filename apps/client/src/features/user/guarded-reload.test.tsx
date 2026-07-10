import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mocks for the dirty shell's side-effecting collaborators.
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));
vi.mock("@/i18n.ts", () => ({ default: { t: (k: string) => k } }));
vi.mock("@/lib/reload-guard", () => ({
  hasAutoReloaded: vi.fn(() => false),
  markAutoReloaded: vi.fn(() => true),
}));

import { notifications } from "@mantine/notifications";
import { hasAutoReloaded, markAutoReloaded } from "@/lib/reload-guard";
import {
  triggerGuardedReload,
  __resetGuardedReloadForTests,
} from "./guarded-reload";

const show = notifications.show as unknown as ReturnType<typeof vi.fn>;
const mockHasAutoReloaded = hasAutoReloaded as unknown as ReturnType<
  typeof vi.fn
>;
const mockMarkAutoReloaded = markAutoReloaded as unknown as ReturnType<
  typeof vi.fn
>;

let reload: ReturnType<typeof vi.fn>;
let visibility: DocumentVisibilityState;

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  __resetGuardedReloadForTests();
  vi.clearAllMocks();
  mockHasAutoReloaded.mockReturnValue(false);
  mockMarkAutoReloaded.mockReturnValue(true);

  vi.stubGlobal("APP_VERSION", "test-A");

  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { reload },
  });

  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("triggerGuardedReload", () => {
  it("noop when versions match: no banner, no reload", () => {
    triggerGuardedReload("test-A");
    expect(show).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("noop when the server version is empty (fail-safe)", () => {
    triggerGuardedReload("");
    triggerGuardedReload(undefined);
    expect(show).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("hidden tab on a real mismatch reloads immediately, no banner", () => {
    visibility = "hidden";
    triggerGuardedReload("test-B");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
  });

  it("visible tab on a real mismatch shows the banner and arms a reload on hidden", () => {
    triggerGuardedReload("test-B");
    // Banner shown, no immediate reload.
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatchObject({
      id: "app-version-reload",
      autoClose: false,
      withCloseButton: true,
    });
    expect(reload).not.toHaveBeenCalled();

    // Going to the background triggers the guarded auto-reload.
    setVisibility("hidden");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("banner-only (auto-reload already spent): banner, never auto-reload", () => {
    mockHasAutoReloaded.mockReturnValue(true);
    triggerGuardedReload("test-B");
    expect(show).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();

    // Even backgrounding must not reload (no listener was armed).
    setVisibility("hidden");
    expect(reload).not.toHaveBeenCalled();
  });

  it("does NOT reload when the flag write fails; falls back to the banner", () => {
    mockMarkAutoReloaded.mockReturnValue(false);
    visibility = "hidden";
    triggerGuardedReload("test-B");
    expect(reload).not.toHaveBeenCalled();
    // performAutoReload falls back to showing the banner.
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("is idempotent within a tab-load: repeated emits do not stack banners", () => {
    triggerGuardedReload("test-B");
    triggerGuardedReload("test-B");
    triggerGuardedReload("test-C");
    expect(show).toHaveBeenCalledTimes(1);
  });
});
