import api from "@/lib/api-client";

/** #568 — one calendar day of the page-history heatmap: the number of *version*
 *  revisions (manual/agent) on that day, keyed by 'YYYY-MM-DD' in the viewer tz.
 *  Same set as the "Only versions" filter, so a lit day always has a list row. */
export interface IPageHistoryDayCount {
  dayISO: string;
  count: number;
}

export async function getPageHistoryDayCounts(
  pageId: string,
  tz: string,
): Promise<IPageHistoryDayCount[]> {
  const req = await api.post<IPageHistoryDayCount[]>(
    "/pages/history/day-counts",
    { pageId, tz },
  );
  return req.data;
}
