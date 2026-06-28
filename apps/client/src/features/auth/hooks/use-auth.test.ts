import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// react-i18next: identity t() so the hook renders without an i18n provider.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// react-router-dom: only useNavigate is used by the hook.
const navigateMock = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

// The auth service is the network boundary; stub login/logout per test.
const loginMock = vi.fn();
const logoutMock = vi.fn();
vi.mock("@/features/auth/services/auth-service", () => ({
  login: (...args: unknown[]) => loginMock(...args),
  logout: (...args: unknown[]) => logoutMock(...args),
  forgotPassword: vi.fn(),
  passwordReset: vi.fn(),
  setupWorkspace: vi.fn(),
  verifyUserToken: vi.fn(),
}));

vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  acceptInvitation: vi.fn(),
}));

// The offline cache purge is the unit under test — assert it is invoked.
const clearOfflineCacheMock = vi.fn();
vi.mock("@/features/offline/clear-offline-cache", () => ({
  clearOfflineCache: () => clearOfflineCacheMock(),
}));

// app-route helpers are pure config; provide deterministic values.
vi.mock("@/lib/app-route.ts", () => ({
  default: { AUTH: { LOGIN: "/login" }, HOME: "/home" },
  getPostLoginRedirect: () => "/home",
}));

// Mantine notifications: avoid touching the DOM-bound notification system.
vi.mock("@mantine/notifications", () => ({
  notifications: { show: vi.fn() },
}));

import useAuth from "./use-auth";

beforeEach(() => {
  navigateMock.mockReset();
  loginMock.mockReset();
  loginMock.mockResolvedValue(undefined);
  logoutMock.mockReset();
  logoutMock.mockResolvedValue(undefined);
  clearOfflineCacheMock.mockReset();
  clearOfflineCacheMock.mockResolvedValue(undefined);
});

describe("useAuth.handleSignIn", () => {
  it("clears the offline cache BEFORE logging in (cross-user leak guard)", async () => {
    const order: string[] = [];
    clearOfflineCacheMock.mockImplementation(async () => {
      order.push("clear");
    });
    loginMock.mockImplementation(async () => {
      order.push("login");
    });

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.signIn({ email: "b@x", password: "pw" } as any);
    });

    expect(clearOfflineCacheMock).toHaveBeenCalledTimes(1);
    expect(loginMock).toHaveBeenCalledTimes(1);
    // The purge must run before the new session's login resolves.
    expect(order).toEqual(["clear", "login"]);
    expect(navigateMock).toHaveBeenCalledWith("/home");
  });

  it("does not block sign-in when the cache purge throws (best-effort)", async () => {
    clearOfflineCacheMock.mockRejectedValue(new Error("idb unavailable"));

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.signIn({ email: "b@x", password: "pw" } as any);
    });

    // Login still proceeds despite the cleanup failure.
    expect(loginMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/home");
  });
});

describe("useAuth.handleLogout", () => {
  const replaceMock = vi.fn();
  let originalLocation: Location;

  beforeEach(() => {
    replaceMock.mockReset();
    // window.location.replace is the post-logout redirect. jsdom's real `replace`
    // is a non-configurable method that warns "not implemented", so swap the
    // whole location object for one whose `replace` we can capture.
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { replace: replaceMock },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("purges the offline cache exactly once BEFORE redirecting (cross-user leak guard)", async () => {
    const order: string[] = [];
    clearOfflineCacheMock.mockImplementation(async () => {
      order.push("clear");
    });
    replaceMock.mockImplementation((url: string) => {
      order.push(`replace:${url}`);
    });

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });

    expect(clearOfflineCacheMock).toHaveBeenCalledTimes(1);
    // Purge must complete before the redirect (which would otherwise interrupt
    // the async cleanup).
    expect(order).toEqual(["clear", "replace:/login?logout=1"]);
  });

  it("still redirects when the cache purge throws (best-effort, never blocks logout)", async () => {
    clearOfflineCacheMock.mockRejectedValue(new Error("idb unavailable"));

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.logout();
    });

    // The thrown purge error is swallowed and the redirect still fires.
    expect(clearOfflineCacheMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock).toHaveBeenCalledWith("/login?logout=1");
  });
});
