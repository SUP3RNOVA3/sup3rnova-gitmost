import { describe, it, expect, vi, beforeEach } from "vitest";
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

// The auth service is the network boundary; stub login per test.
const loginMock = vi.fn();
vi.mock("@/features/auth/services/auth-service", () => ({
  login: (...args: unknown[]) => loginMock(...args),
  logout: vi.fn(),
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
