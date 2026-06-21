import { describe, it, expect, afterEach } from "vitest";
import { isCapacitorNativePlatform } from "./is-capacitor";

describe("isCapacitorNativePlatform", () => {
  afterEach(() => {
    // Keep tests isolated from each other and from the rest of the suite.
    delete (globalThis as any).Capacitor;
  });

  it("returns false when Capacitor is undefined", () => {
    expect(isCapacitorNativePlatform()).toBe(false);
  });

  it("uses isNativePlatform() when it is a function", () => {
    (globalThis as any).Capacitor = { isNativePlatform: () => true };
    expect(isCapacitorNativePlatform()).toBe(true);

    (globalThis as any).Capacitor = { isNativePlatform: () => false };
    expect(isCapacitorNativePlatform()).toBe(false);
  });

  it("falls back to the boolean property when isNativePlatform is not a function", () => {
    (globalThis as any).Capacitor = { isNativePlatform: true };
    expect(isCapacitorNativePlatform()).toBe(true);

    (globalThis as any).Capacitor = { isNativePlatform: false };
    expect(isCapacitorNativePlatform()).toBe(false);
  });

  it("returns false when reading Capacitor throws (try/catch)", () => {
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(isCapacitorNativePlatform()).toBe(false);
  });
});
