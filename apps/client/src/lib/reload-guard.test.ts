import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hasAutoReloaded,
  markAutoReloaded,
  recordReloadBreadcrumb,
  takeReloadBreadcrumb,
} from "./reload-guard";

const FLAG = "chunk-reload-attempted";

describe("reload-guard", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("hasAutoReloaded is false before any reload, true after mark", () => {
    expect(hasAutoReloaded()).toBe(false);
    expect(markAutoReloaded()).toBe(true);
    expect(hasAutoReloaded()).toBe(true);
    // Uses the same key the reactive chunk-load boundary reads.
    expect(sessionStorage.getItem(FLAG)).toBe("1");
  });

  it("hasAutoReloaded returns true when reading storage throws (fail toward not reloading)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    try {
      expect(hasAutoReloaded()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("markAutoReloaded returns false when writing storage throws", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
    try {
      expect(markAutoReloaded()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records and then takes a breadcrumb once (cleared on read)", () => {
    recordReloadBreadcrumb({
      path: "proactive",
      serverVersion: "test-B",
      clientVersion: "test-A",
    });
    const crumb = takeReloadBreadcrumb();
    expect(crumb).toMatchObject({
      path: "proactive",
      serverVersion: "test-B",
      clientVersion: "test-A",
    });
    expect(typeof crumb?.at).toBe("number");
    // Cleared on read → a second take returns null.
    expect(takeReloadBreadcrumb()).toBeNull();
  });

  it("takeReloadBreadcrumb returns null when nothing was recorded", () => {
    expect(takeReloadBreadcrumb()).toBeNull();
  });

  it("recordReloadBreadcrumb swallows a storage-write error (diagnostics only)", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {},
    });
    try {
      expect(() =>
        recordReloadBreadcrumb({ path: "chunk-boundary" }),
      ).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
