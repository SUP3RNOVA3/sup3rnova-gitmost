import { TimelineSample } from './work-time.types';
import { zonedDayStart, isoDay } from './bucket-by-day';

/** One calendar day of the page-history heatmap (#568): the number of
 *  *version* revisions (kind ∈ {manual, agent}) that landed on that day. */
export interface DayCount {
  /** 'YYYY-MM-DD' in the requested tz — the same stable key the client uses to
   *  group the dense revision list, so a heatmap cell always maps to a list row. */
  dayISO: string;
  count: number;
}

/**
 * #568 — pure, tz-aware "revisions per day" bucketer for the mini-calendar
 * heatmap. Reuses the already-tested tz core (`zonedDayStart` + `isoDay` from
 * bucket-by-day.ts) so DST/day boundaries stay identical to the work-time
 * punch-card — no copy-pasted date math.
 *
 * Only VERSION rows are counted (`kind === 'manual' | 'agent'`): the heatmap and
 * the client's "Only versions" filter then describe the same set, so every lit
 * day has a visible target in the list (issue criterion 6). Autosnapshots
 * (idle/boundary/legacy null) are ignored.
 *
 * Returns days ascending by `dayISO`; days with no version revision are omitted
 * (the client renders a full month grid and treats a missing day as count 0).
 */
export function countRevisionsByDay(
  rows: ReadonlyArray<Pick<TimelineSample, 'createdAt' | 'kind'>>,
  tz: string,
): DayCount[] {
  const tally = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== 'manual' && row.kind !== 'agent') continue;
    const ms = new Date(row.createdAt).getTime();
    if (Number.isNaN(ms)) continue;
    const key = isoDay(zonedDayStart(ms, tz), tz);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([dayISO, count]) => ({ dayISO, count }))
    .sort((a, b) => (a.dayISO < b.dayISO ? -1 : a.dayISO > b.dayISO ? 1 : 0));
}
