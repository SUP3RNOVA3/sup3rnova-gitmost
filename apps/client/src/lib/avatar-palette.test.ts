import { describe, it, expect } from "vitest";
import {
  PALETTE,
  avatarStyle,
  avatarBackgroundCss,
  normalizeName,
  minPairwiseDistance,
} from "./avatar-palette";

describe("avatar-palette validation", () => {
  it("palette colors stay distinguishable", () => {
    // 0.06 in OKLab is ~4-5 JNDs — safely distinct at avatar size. If a future
    // RINGS tweak drops this, "almost identical" colors would reappear.
    expect(minPairwiseDistance().distance).toBeGreaterThanOrEqual(0.06);
    expect(PALETTE.length).toBe(20);
  });

  it("every palette entry is a hex with a valid WCAG text color", () => {
    for (const entry of PALETTE) {
      expect(entry.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(["white", "black"]).toContain(entry.text);
    }
  });
});

describe("avatarStyle", () => {
  it("name-to-avatar mapping is frozen (golden values)", () => {
    // Golden slice: if this breaks, all existing avatars change — make sure
    // that is intentional (a config change in avatar-palette.ts).
    const s = avatarStyle("Backend Developer");
    expect([s.bg, s.bg2, s.angleDeg]).toEqual(["#a55795", "#90355e", 150]);
    expect(s.text).toBe("white");
  });

  it("is deterministic and normalizes the name", () => {
    expect(avatarStyle("Researcher")).toEqual(avatarStyle("Researcher"));
    // Casing, surrounding and repeated whitespace must not change the avatar.
    expect(avatarStyle("  RESEARCHER ")).toEqual(avatarStyle("researcher"));
    expect(avatarStyle("Backend   Developer")).toEqual(
      avatarStyle("backend developer"),
    );
    expect(normalizeName("  PM ")).toBe("pm");
  });

  it("returns a valid base color, angle and matching text", () => {
    const s = avatarStyle("Нарратор");
    const idx = PALETTE.findIndex((e) => e.hex === s.bg);
    expect(idx).toBe(s.paletteIndex);
    expect(idx).toBeGreaterThanOrEqual(0); // bg is a palette entry
    // Text color comes from the chosen palette entry.
    expect(s.text).toBe(PALETTE[idx].text);
    // Split angle is one of the SPLIT_ANGLE_STEPS (24) directions → multiples of 15.
    expect(s.angleDeg % 15).toBe(0);
    expect(s.angleDeg).toBeGreaterThanOrEqual(0);
    expect(s.angleDeg).toBeLessThan(360);
  });

  it("distinguishes the agents that used to collide as violet", () => {
    // "Структурный редактор" and "Фактчекер" looked identically violet before.
    expect(avatarStyle("Структурный редактор")).not.toEqual(
      avatarStyle("Фактчекер"),
    );
  });
});

describe("avatarBackgroundCss", () => {
  it("renders a two-stop gradient with a soft boundary", () => {
    const s = avatarStyle("Backend Developer");
    expect(avatarBackgroundCss(s)).toBe(
      "linear-gradient(150deg, #a55795 42%, #90355e 58%)",
    );
  });
});
