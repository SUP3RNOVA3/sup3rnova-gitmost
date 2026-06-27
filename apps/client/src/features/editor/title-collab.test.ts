import { describe, it, expect, vi, beforeEach } from "vitest";

// isChangeOrigin is mocked so we can simulate local vs remote/collab-origin
// transactions without constructing a real ProseMirror/Yjs transaction.
const isChangeOriginMock = vi.hoisted(() => vi.fn());
vi.mock("@tiptap/extension-collaboration", () => ({
  isChangeOrigin: isChangeOriginMock,
}));

import { shouldPropagateTitleChange } from "./title-collab";

beforeEach(() => {
  isChangeOriginMock.mockReset();
});

describe("shouldPropagateTitleChange", () => {
  it("propagates a genuine local edit (isChangeOrigin false)", () => {
    isChangeOriginMock.mockReturnValue(false);
    expect(shouldPropagateTitleChange({ local: true })).toBe(true);
    expect(isChangeOriginMock).toHaveBeenCalledWith({ local: true });
  });

  it("skips a remote/collab-origin update (isChangeOrigin true)", () => {
    isChangeOriginMock.mockReturnValue(true);
    expect(shouldPropagateTitleChange({ remote: true })).toBe(false);
  });

  it("propagates when there is no transaction (treated as local)", () => {
    expect(shouldPropagateTitleChange(undefined)).toBe(true);
    // isChangeOrigin must not be called for a missing transaction.
    expect(isChangeOriginMock).not.toHaveBeenCalled();
  });
});
