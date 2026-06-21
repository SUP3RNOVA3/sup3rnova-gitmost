import { describe, it, expect } from "vitest";
import { isApiPath, isCollabOrSocketPath } from "./sw-strategy";

describe("isApiPath", () => {
  it("matches the /api segment and its subtree", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/")).toBe(true);
    expect(isApiPath("/api/pages")).toBe(true);
  });

  it("does not over-match sibling paths", () => {
    expect(isApiPath("/apidocs")).toBe(false);
    expect(isApiPath("/apixyz")).toBe(false);
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/pages")).toBe(false);
  });
});

describe("isCollabOrSocketPath", () => {
  it("matches the /collab and /socket.io segments and their subtrees", () => {
    expect(isCollabOrSocketPath("/collab")).toBe(true);
    expect(isCollabOrSocketPath("/collab/x")).toBe(true);
    expect(isCollabOrSocketPath("/socket.io")).toBe(true);
    expect(isCollabOrSocketPath("/socket.io/abc")).toBe(true);
  });

  it("does not over-match sibling paths", () => {
    expect(isCollabOrSocketPath("/collaborators")).toBe(false);
    expect(isCollabOrSocketPath("/collabx")).toBe(false);
    expect(isCollabOrSocketPath("/socket.iox")).toBe(false);
  });
});
