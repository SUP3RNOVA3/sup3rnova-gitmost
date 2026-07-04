import { describe, it, expect } from "vitest";
import { WebSocketStatus } from "@hocuspocus/provider";
import {
  isCollabSynced,
  isBodyEditable,
  computeDictationAvailability,
} from "./editor-sync-state";

describe("isCollabSynced", () => {
  it("is true only when Connected and synced", () => {
    expect(isCollabSynced(WebSocketStatus.Connected, true)).toBe(true);
  });

  it("is false while connecting or not yet synced", () => {
    expect(isCollabSynced(WebSocketStatus.Connecting, true)).toBe(false);
    expect(isCollabSynced(WebSocketStatus.Connected, false)).toBe(false);
    expect(isCollabSynced(WebSocketStatus.Disconnected, true)).toBe(false);
  });
});

describe("isBodyEditable (pre-sync data-loss gate, #218)", () => {
  const base = { editable: true, inEditMode: true, showStatic: false };

  it("allows editing only after the static (pre-sync) phase ends", () => {
    expect(isBodyEditable(base)).toBe(true);
  });

  it("never editable while the static read-only editor is shown", () => {
    expect(isBodyEditable({ ...base, showStatic: true })).toBe(false);
  });

  it("honors read-only and view mode", () => {
    expect(isBodyEditable({ ...base, editable: false })).toBe(false);
    expect(isBodyEditable({ ...base, inEditMode: false })).toBe(false);
  });
});

describe("computeDictationAvailability (mic reason precedence, #309)", () => {
  const base = {
    editable: true,
    inEditMode: true,
    showStatic: false,
    isDisconnected: false,
  };

  it("is available with no reason once synced (showStatic false)", () => {
    expect(computeDictationAvailability(base)).toEqual({
      isEditable: true,
      reason: null,
    });
  });

  it("reports 'offline' during pre-sync while disconnected", () => {
    expect(
      computeDictationAvailability({
        ...base,
        showStatic: true,
        isDisconnected: true,
      }),
    ).toEqual({ isEditable: false, reason: "offline" });
  });

  it("reports 'connecting' during pre-sync while still connecting", () => {
    expect(
      computeDictationAvailability({
        ...base,
        showStatic: true,
        isDisconnected: false,
      }),
    ).toEqual({ isEditable: false, reason: "connecting" });
  });

  it("reports 'read-only' without edit permission", () => {
    expect(
      computeDictationAvailability({ ...base, editable: false }),
    ).toEqual({ isEditable: false, reason: "read-only" });
  });

  it("reports 'read-only' when not in edit mode", () => {
    expect(
      computeDictationAvailability({ ...base, inEditMode: false }),
    ).toEqual({ isEditable: false, reason: "read-only" });
  });

  // Lack of edit permission takes precedence over the pre-sync reason: a
  // read-only viewer who is ALSO inside the pre-sync window (showStatic) must
  // still read "read-only", never "offline"/"connecting". This pins the
  // `opts.editable &&` guard on the pre-sync branch.
  it("prefers 'read-only' over pre-sync when a read-only viewer is disconnected", () => {
    expect(
      computeDictationAvailability({
        editable: false,
        inEditMode: true,
        showStatic: true,
        isDisconnected: true,
      }),
    ).toEqual({ isEditable: false, reason: "read-only" });
  });

  it("prefers 'read-only' over pre-sync when a read-only viewer is still connecting", () => {
    expect(
      computeDictationAvailability({
        editable: false,
        inEditMode: true,
        showStatic: true,
        isDisconnected: false,
      }),
    ).toEqual({ isEditable: false, reason: "read-only" });
  });
});
