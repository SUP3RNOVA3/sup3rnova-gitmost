import { Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useMemo } from "react";
import { IPageWorkTime, IPerDay, IDayWindow } from "./work-time.types";
import {
  formatDayTotal,
  formatGapMinutes,
  formatHeadline,
} from "./format-work-time";
import classes from "./work-time.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;
// Collapse a run of this many (or more) consecutive edit-free days into a single
// "× N days" separator (§6.2 long-range) — the row is still always one day.
const EMPTY_RUN_COLLAPSE = 8;

type Row =
  | { type: "day"; day: IPerDay }
  | { type: "gap"; count: number };

function collapseEmptyRuns(perDay: IPerDay[]): Row[] {
  const rows: Row[] = [];
  let emptyRun: IPerDay[] = [];
  const flush = () => {
    if (emptyRun.length >= EMPTY_RUN_COLLAPSE) {
      rows.push({ type: "gap", count: emptyRun.length });
    } else {
      for (const d of emptyRun) rows.push({ type: "day", day: d });
    }
    emptyRun = [];
  };
  for (const d of perDay) {
    if (d.activeMs === 0 && d.agentMs === 0) {
      emptyRun.push(d);
    } else {
      flush();
      rows.push({ type: "day", day: d });
    }
  }
  flush();
  return rows;
}

function dayHeading(day: number): string {
  return new Date(day).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function DayTrack({
  day,
  pSingle,
}: {
  day: IPerDay;
  pSingle: number;
}) {
  const { t } = useTranslation();
  const ticks = [6, 12, 18];
  return (
    <div className={classes.row}>
      <span className={classes.dayLabel}>{dayHeading(day.day)}</span>
      <div className={classes.track}>
        {ticks.map((h) => (
          <div
            key={h}
            className={classes.hourTick}
            style={{ left: `${(h / 24) * 100}%` }}
          />
        ))}
        {day.windows.map((w: IDayWindow, i) => {
          const leftPct = ((w.start - day.day) / DAY_MS) * 100;
          const widthPct = ((w.end - w.start) / DAY_MS) * 100;
          const isSingle = w.end - w.start <= pSingle;
          const cls = [
            classes.window,
            w.class === "work" ? classes.windowWork : classes.windowAgent,
            isSingle ? classes.windowSingle : "",
          ].join(" ");
          return (
            <div
              key={i}
              className={cls}
              style={{
                left: `${Math.max(0, Math.min(100, leftPct))}%`,
                width: `${Math.max(0, Math.min(100, widthPct))}%`,
              }}
            />
          );
        })}
      </div>
      <span className={classes.daySum}>
        {formatDayTotal(day.activeMs, t)}
      </span>
    </div>
  );
}

interface Props {
  data: IPageWorkTime;
}

export default function WorkTimePunchCard({ data }: Props) {
  const { t } = useTranslation();
  const rows = useMemo(() => collapseEmptyRuns(data.perDay), [data.perDay]);
  const gapMin = formatGapMinutes(data.config.tGap);

  if (data.workMs <= 0 && data.agentOnlyMs <= 0) {
    return (
      <Text size="sm" c="dimmed" py="md">
        {t("No editing activity recorded yet.")}
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      <Group gap="lg">
        <Text size="sm" fw={500}>
          {formatHeadline(data.workMs, t)}
        </Text>
        {data.agentOnlyMs > 0 && (
          <Text size="xs" c="dimmed">
            {t("agent: {{value}}", { value: formatHeadline(data.agentOnlyMs, t) })}
          </Text>
        )}
      </Group>

      <Group gap="md">
        <Text size="xs" c="dimmed">
          <span
            className={`${classes.legendSwatch} ${classes.windowWork}`}
            style={{ marginRight: 4 }}
          />
          {t("Work")}
        </Text>
        <Text size="xs" c="dimmed">
          <span
            className={`${classes.legendSwatch} ${classes.windowAgent}`}
            style={{ marginRight: 4 }}
          />
          {t("Agent")}
        </Text>
      </Group>

      <div>
        {rows.map((row, i) =>
          row.type === "day" ? (
            <DayTrack
              key={row.day.dayISO}
              day={row.day}
              pSingle={data.config.pSingle}
            />
          ) : (
            <div key={`gap-${i}`} className={classes.gapRow}>
              {t("× {{count}} days without edits", { count: row.count })}
            </div>
          ),
        )}
      </div>

      <Text size="xs" c="dimmed" mt="xs">
        {t("Estimate · timezone {{tz}} · inactivity gap {{gap}} min", {
          tz: data.tz,
          gap: gapMin,
        })}
      </Text>
    </Stack>
  );
}
