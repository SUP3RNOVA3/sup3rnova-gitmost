import { describe, it, expect } from "vitest";
import {
  dayGroupLabel,
  groupRevisionsByDay,
  heatLevel,
  isoDayInTz,
  toRevisionRow,
  RevisionRowData,
} from "./revision-row";
import { IPageHistory } from "@/features/page-history/types/page.types";

function hist(partial: Partial<IPageHistory>): IPageHistory {
  return {
    id: "id",
    createdAt: "2026-07-12T05:35:00Z",
    lastUpdatedBy: { id: "u1", name: "Alice", avatarUrl: "" },
    ...partial,
  } as IPageHistory;
}

describe("toRevisionRow — kind → badge/glyph mapping (#568/#370)", () => {
  it("manual → SAVED badge (saved) and a version, human glyph", () => {
    const row = toRevisionRow(
      hist({ kind: "manual", lastUpdatedSource: "user" }),
      "UTC",
    );
    expect(row.saved).toBe(true);
    expect(row.version).toBe(true);
    expect(row.isAgent).toBe(false);
    expect(row.authorName).toBe("Alice");
  });

  it("agent → NO saved badge but IS a version, agent glyph + launcher (via)", () => {
    const row = toRevisionRow(
      hist({
        kind: "agent",
        lastUpdatedSource: "agent",
        agent: { name: "Corrector", emoji: "🛠" },
        launcher: { name: "Bob" },
      }),
      "UTC",
    );
    // SAVED is only for manual — the agent version relies on its glyph.
    expect(row.saved).toBe(false);
    expect(row.version).toBe(true);
    expect(row.isAgent).toBe(true);
    expect(row.agentName).toBe("Corrector");
    expect(row.agentEmoji).toBe("🛠");
    expect(row.launcherName).toBe("Bob");
  });

  it("agent AUTOSAVE keeps agent identity (glyph) but is not a version, no badge", () => {
    // Two orthogonal signals: identity=agent, intentionality=idle (autosave).
    const row = toRevisionRow(
      hist({
        kind: "idle",
        lastUpdatedSource: "agent",
        agent: { name: "Factchecker", emoji: null },
        launcher: { name: "Bob" },
      }),
      "UTC",
    );
    expect(row.isAgent).toBe(true); // identity preserved
    expect(row.saved).toBe(false);
    expect(row.version).toBe(false); // dimmed autosave
  });

  it("autosave (null kind, human) → not a version, dimmed, no badge, human glyph", () => {
    const row = toRevisionRow(
      hist({ kind: null, lastUpdatedSource: "user" }),
      "UTC",
    );
    expect(row.saved).toBe(false);
    expect(row.version).toBe(false);
    expect(row.isAgent).toBe(false);
  });

  it("source=agent WITHOUT resolved agent → human glyph (no square glyph)", () => {
    const row = toRevisionRow(
      hist({ kind: "manual", lastUpdatedSource: "agent", agent: null }),
      "UTC",
    );
    expect(row.isAgent).toBe(false);
  });
});

describe("isoDayInTz — stable per-row day key in a tz", () => {
  it("formats YYYY-MM-DD and shifts with the tz", () => {
    // 02:00 UTC is the previous calendar day in America/New_York (22:00).
    const d = new Date("2026-07-04T02:00:00Z");
    expect(isoDayInTz(d, "UTC")).toBe("2026-07-04");
    expect(isoDayInTz(d, "America/New_York")).toBe("2026-07-03");
  });
});

describe("groupRevisionsByDay — contiguous day buckets, order preserved", () => {
  it("buckets newest-first rows into day groups", () => {
    const rows: RevisionRowData[] = [
      { dayISO: "2026-07-12", ts: 3 } as RevisionRowData,
      { dayISO: "2026-07-12", ts: 2 } as RevisionRowData,
      { dayISO: "2026-07-11", ts: 1 } as RevisionRowData,
    ];
    const groups = groupRevisionsByDay(rows);
    expect(groups.map((g) => g.dayISO)).toEqual(["2026-07-12", "2026-07-11"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });
});

describe("dayGroupLabel — relative Today/Yesterday else absolute", () => {
  const now = new Date("2026-07-12T12:00:00Z");
  it("Today / Yesterday are relative and i18n-able", () => {
    expect(dayGroupLabel({ dayISO: "2026-07-12", ts: 0 }, "UTC", now)).toBe(
      "Today",
    );
    expect(dayGroupLabel({ dayISO: "2026-07-11", ts: 0 }, "UTC", now)).toBe(
      "Yesterday",
    );
  });
  it("older days fall back to an absolute label (not Today/Yesterday)", () => {
    const label = dayGroupLabel(
      { dayISO: "2026-07-04", ts: Date.UTC(2026, 6, 4, 12) },
      "UTC",
      now,
    );
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
    expect(label).toMatch(/4/); // day number present
  });
});

describe("heatLevel — prototype heat() thresholds", () => {
  it("maps counts to 0/1/2/3 tiers", () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(1)).toBe(1);
    expect(heatLevel(2)).toBe(1);
    expect(heatLevel(3)).toBe(2);
    expect(heatLevel(4)).toBe(2);
    expect(heatLevel(5)).toBe(3);
    expect(heatLevel(99)).toBe(3);
  });
});
