import { describe, it, expect } from "vitest";
import { isChunkLoadError, shouldAutoReload } from "./chunk-load-error-boundary";

// The detector decides whether a caught render error is a stale-deploy chunk-404
// (→ auto-reload to fetch the new manifest) vs a genuine app error (→ generic
// recovery UI, no reload). A false negative on a real chunk failure re-blanks the
// app; a false positive would auto-reload on an ordinary error. Pin both sides.
describe("isChunkLoadError", () => {
  it("detects the ChunkLoadError name", () => {
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "x" })).toBe(true);
  });

  it.each([
    "Failed to fetch dynamically imported module: https://x/assets/index-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
  ])("detects the dynamic-import failure message %#", (message) => {
    expect(isChunkLoadError({ name: "TypeError", message })).toBe(true);
  });

  it("is case-insensitive on the message", () => {
    expect(
      isChunkLoadError({ message: "FAILED TO FETCH DYNAMICALLY IMPORTED MODULE" }),
    ).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    { name: "TypeError", message: "Cannot read properties of undefined" },
    { message: "Network request failed" },
    new Error("some ordinary render error"),
  ])("returns false for a non-chunk error %#", (err) => {
    expect(isChunkLoadError(err)).toBe(false);
  });
});

// The window gate replaces the old one-shot flag: it must permit recovery across
// several deploys in one tab (each > window apart) while still stopping an infinite
// reload loop when a lazy chunk is permanently broken (a second failure < window).
describe("shouldAutoReload", () => {
  const WINDOW = 5 * 60 * 1000;
  const NOW = 1_000_000_000_000;

  it("allows a reload when we have never auto-reloaded", () => {
    expect(shouldAutoReload(NOW, null, WINDOW)).toBe(true);
  });

  it("allows a reload when the last one was 6 minutes ago (outside the window)", () => {
    expect(shouldAutoReload(NOW, NOW - 6 * 60 * 1000, WINDOW)).toBe(true);
  });

  it("blocks a reload when the last one was 1 minute ago (inside the window)", () => {
    expect(shouldAutoReload(NOW, NOW - 1 * 60 * 1000, WINDOW)).toBe(false);
  });

  it("blocks a reload exactly at the window boundary (not strictly older)", () => {
    expect(shouldAutoReload(NOW, NOW - WINDOW, WINDOW)).toBe(false);
  });

  it("allows a reload when the stored timestamp is unparseable (NaN)", () => {
    expect(shouldAutoReload(NOW, NaN, WINDOW)).toBe(true);
  });
});
