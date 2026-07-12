import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import MiniCalendar from "./mini-calendar";
import { isoDayInTz } from "@/features/page-history/utils/revision-row";

// matchMedia (read by MantineProvider) is stubbed globally in vitest.setup.ts.

const TZ = "UTC";

function renderCal(counts: Map<string, number>, onPickDay = vi.fn()) {
  const todayISO = isoDayInTz(new Date(), TZ);
  return {
    todayISO,
    onPickDay,
    ...render(
      <MantineProvider>
        <MiniCalendar
          counts={counts}
          selectedDayISO={todayISO}
          onPickDay={onPickDay}
          tz={TZ}
        />
      </MantineProvider>,
    ),
  };
}

describe("MiniCalendar (#568 heatmap)", () => {
  it("renders a 6x7 grid and highlights the selected day", () => {
    const { todayISO } = renderCal(new Map());
    const cells = screen.getAllByTestId("calendar-day");
    expect(cells).toHaveLength(42);
    const today = cells.find((c) => c.getAttribute("data-day") === todayISO)!;
    expect(today.className).toContain("calDaySelected");
  });

  it("applies a heat class scaled to the day's revision count", () => {
    const day = isoDayInTz(new Date(), TZ);
    const { todayISO } = renderCal(new Map([[day, 7]]));
    const today = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("data-day") === todayISO)!;
    // 7 revisions → top tier (calHeat3).
    expect(today.className).toContain("calHeat3");
  });

  it("picking an in-month day delegates the dayISO to onPickDay", () => {
    const { todayISO, onPickDay } = renderCal(new Map());
    const today = screen
      .getAllByTestId("calendar-day")
      .find((c) => c.getAttribute("data-day") === todayISO)!;
    fireEvent.click(today);
    expect(onPickDay).toHaveBeenCalledWith(todayISO);
  });
});
