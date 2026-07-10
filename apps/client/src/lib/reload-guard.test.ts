import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hasAutoReloaded, markAutoReloaded } from "./reload-guard";

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
});
