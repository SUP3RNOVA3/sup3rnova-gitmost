import { countRevisionsByDay } from './day-counts';
import { TimelineSample } from './work-time.types';

function row(createdAt: string, kind: string | null): TimelineSample {
  return {
    createdAt,
    kind,
    lastUpdatedById: 'h',
    lastUpdatedSource: 'user',
    lastUpdatedAiChatId: null,
  };
}

describe('countRevisionsByDay (#568 heatmap aggregate)', () => {
  it('empty input → no days', () => {
    expect(countRevisionsByDay([], 'UTC')).toEqual([]);
  });

  it('counts only VERSION rows (manual/agent); ignores autosnapshots', () => {
    const rows: TimelineSample[] = [
      row('2026-07-04T10:00:00Z', 'manual'),
      row('2026-07-04T11:00:00Z', 'agent'),
      row('2026-07-04T12:00:00Z', 'idle'), // ignored
      row('2026-07-04T13:00:00Z', 'boundary'), // ignored
      row('2026-07-04T14:00:00Z', null), // legacy autosave, ignored
    ];
    expect(countRevisionsByDay(rows, 'UTC')).toEqual([
      { dayISO: '2026-07-04', count: 2 },
    ]);
  });

  it('groups by calendar day and returns days ascending', () => {
    const rows: TimelineSample[] = [
      row('2026-07-06T09:00:00Z', 'manual'),
      row('2026-07-04T09:00:00Z', 'manual'),
      row('2026-07-04T20:00:00Z', 'agent'),
      row('2026-07-05T01:00:00Z', 'manual'),
    ];
    expect(countRevisionsByDay(rows, 'UTC')).toEqual([
      { dayISO: '2026-07-04', count: 2 },
      { dayISO: '2026-07-05', count: 1 },
      { dayISO: '2026-07-06', count: 1 },
    ]);
  });

  it('buckets in the requested tz — the same instant can fall on a different day', () => {
    // 2026-07-04T02:00:00Z is still 2026-07-03 (22:00) in America/New_York.
    const rows: TimelineSample[] = [row('2026-07-04T02:00:00Z', 'manual')];
    expect(countRevisionsByDay(rows, 'UTC')).toEqual([
      { dayISO: '2026-07-04', count: 1 },
    ]);
    expect(countRevisionsByDay(rows, 'America/New_York')).toEqual([
      { dayISO: '2026-07-03', count: 1 },
    ]);
  });

  it('throws a RangeError on an unknown tz (mapped to 400 by the controller)', () => {
    const rows: TimelineSample[] = [row('2026-07-04T10:00:00Z', 'manual')];
    expect(() => countRevisionsByDay(rows, 'Mars/Phobos')).toThrow(RangeError);
  });

  it('tolerates a Date instance for createdAt (driver may hand back Date)', () => {
    const rows = [
      { ...row('x', 'manual'), createdAt: new Date('2026-07-04T10:00:00Z') },
    ];
    expect(countRevisionsByDay(rows, 'UTC')).toEqual([
      { dayISO: '2026-07-04', count: 1 },
    ]);
  });
});
