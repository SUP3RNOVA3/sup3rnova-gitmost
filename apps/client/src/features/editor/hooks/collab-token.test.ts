import { describe, it, expect, vi, beforeEach } from "vitest";

// jwt-decode is mocked so we can drive the four token states deterministically
// (decode success with a chosen exp, or a thrown decode error).
const decodeMock = vi.hoisted(() => vi.fn());
vi.mock("jwt-decode", () => ({
  jwtDecode: decodeMock,
}));

import { collabTokenNeedsRefresh } from "./collab-token";

const NOW_MS = 1_000_000_000; // fixed "now" in ms (so NOW_MS/1000 seconds)

beforeEach(() => {
  decodeMock.mockReset();
});

describe("collabTokenNeedsRefresh", () => {
  it("returns true when there is no token (fetch a fresh one)", () => {
    expect(collabTokenNeedsRefresh(undefined, NOW_MS)).toBe(true);
    // jwtDecode must not even be called for a missing token.
    expect(decodeMock).not.toHaveBeenCalled();
  });

  it("returns true when the token is malformed (jwtDecode throws)", () => {
    decodeMock.mockImplementation(() => {
      throw new Error("invalid token");
    });
    expect(collabTokenNeedsRefresh("garbage", NOW_MS)).toBe(true);
  });

  it("returns false for a valid, not-yet-expired token (no reconnect)", () => {
    // exp is in the future relative to NOW.
    decodeMock.mockReturnValue({ exp: NOW_MS / 1000 + 60 });
    expect(collabTokenNeedsRefresh("good", NOW_MS)).toBe(false);
  });

  it("returns true for a valid but expired token (refresh + reconnect)", () => {
    // exp is in the past relative to NOW.
    decodeMock.mockReturnValue({ exp: NOW_MS / 1000 - 60 });
    expect(collabTokenNeedsRefresh("expired", NOW_MS)).toBe(true);
  });

  it("treats exp exactly equal to now as expired (>= boundary)", () => {
    decodeMock.mockReturnValue({ exp: NOW_MS / 1000 });
    expect(collabTokenNeedsRefresh("boundary", NOW_MS)).toBe(true);
  });
});
