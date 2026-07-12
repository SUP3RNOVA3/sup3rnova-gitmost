import { computeWorkTime } from './compute-work-time';
import { TimelineSample } from './work-time.types';

const MIN = 60 * 1000;

function s(
  iso: string,
  opts: {
    source?: string | null;
    chat?: string | null;
    kind?: string | null;
    by?: string | null;
  } = {},
): TimelineSample {
  return {
    createdAt: `${iso}Z`,
    lastUpdatedById: opts.by ?? 'human-1',
    lastUpdatedSource: opts.source === undefined ? 'user' : opts.source,
    lastUpdatedAiChatId: opts.chat ?? null,
    kind: opts.kind ?? null,
  };
}

// §7 config: T_gap=30m, P_in+P_out=10m, P_single=2m.
const S7 = { tGap: 30 * MIN, agentTGap: 30 * MIN, pIn: 5 * MIN, pOut: 5 * MIN, pSingle: 2 * MIN };

describe('computeWorkTime', () => {
  it('§7 fixture — sessionizes 20-ish samples to ≈1h32m, not the ≈60h naive span', () => {
    const rows: TimelineSample[] = [
      // S1: multi-sample morning session
      s('2026-07-04T03:40:00'),
      s('2026-07-04T03:45:00'),
      s('2026-07-04T03:49:00'),
      // S2: agent burst (one run) then human supervising → class work
      s('2026-07-04T15:43:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T15:47:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T15:50:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T16:13:00'),
      // S3: single
      s('2026-07-04T18:11:00'),
      // S4: multi-sample evening session
      s('2026-07-04T19:38:00'),
      s('2026-07-04T19:44:00'),
      s('2026-07-04T19:54:00'),
      // S5 / S6: two singles two days later, 44m apart → two sessions at T_gap=30
      s('2026-07-06T15:34:00'),
      s('2026-07-06T16:18:00'),
    ];

    const r = computeWorkTime(rows, S7);

    // 19 + 40 + 2 + 26 + 2 + 2 = 91 minutes.
    expect(r.workMs).toBe(91 * MIN);
    expect(r.agentOnlyMs).toBe(0);
    expect(r.sessions).toHaveLength(6);
    expect(r.sessions.every((x) => x.class === 'work')).toBe(true);

    const naiveSpan =
      new Date('2026-07-06T16:18:00Z').getTime() -
      new Date('2026-07-04T03:40:00Z').getTime();
    expect(naiveSpan).toBeGreaterThan(60 * 60 * MIN); // ≈60h
    expect(r.workMs).toBeLessThan(naiveSpan / 30); // dramatically smaller
  });

  it('n=0 → zero, no sessions', () => {
    const r = computeWorkTime([]);
    expect(r).toEqual({ workMs: 0, agentOnlyMs: 0, sessions: [] });
  });

  it('n=1 human → one P_single work session', () => {
    const r = computeWorkTime([s('2026-07-04T10:00:00')], S7);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('work');
    expect(r.workMs).toBe(2 * MIN);
    expect(r.agentOnlyMs).toBe(0);
    // pre-roll only: [t − P_single, t]
    expect(r.sessions[0].end).toBe(new Date('2026-07-04T10:00:00Z').getTime());
  });

  it('n=1 agent → one P_single agent_only session, work=0 (§9#2)', () => {
    const r = computeWorkTime(
      [s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' })],
      S7,
    );
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('agent_only');
    expect(r.workMs).toBe(0);
    expect(r.agentOnlyMs).toBe(2 * MIN);
  });

  it('MUST close the last session — the newest session is not lost (§9#1)', () => {
    // Two singles a day apart: without the post-loop close, the 2nd is dropped.
    const rows = [s('2026-07-04T10:00:00'), s('2026-07-05T10:00:00')];
    const r = computeWorkTime(rows, S7);
    expect(r.sessions).toHaveLength(2);
    const lastStart = Math.max(...r.sessions.map((x) => x.start));
    expect(lastStart).toBe(
      new Date('2026-07-05T10:00:00Z').getTime() - 2 * MIN,
    );
    expect(r.workMs).toBe(4 * MIN);
  });

  it('agent-burst collapse: density does not inflate — length = wall-clock', () => {
    const span = ['00', '01', '02', '03', '04', '05', '06'];
    const dense: TimelineSample[] = span.map((sec) =>
      s(`2026-07-04T10:00:${sec}`, { source: 'agent', chat: 'c1', kind: 'agent' }),
    );
    const sparse: TimelineSample[] = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:00:06', { source: 'agent', chat: 'c1', kind: 'agent' }),
    ];
    const rDense = computeWorkTime(dense, S7);
    const rSparse = computeWorkTime(sparse, S7);
    // Same 6-second wall-clock span → same estimate regardless of snapshot count.
    expect(rDense.agentOnlyMs).toBe(rSparse.agentOnlyMs);
    expect(rDense.sessions).toHaveLength(1);
    expect(rDense.sessions[0].class).toBe('agent_only');
  });

  it('supervisory agent time inside a human session counts as work, not agent', () => {
    const rows = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:05:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:12:00'), // human within T_gap
    ];
    const r = computeWorkTime(rows, S7);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('work');
    expect(r.agentOnlyMs).toBe(0);
    expect(r.workMs).toBeGreaterThan(0);
  });

  it('a DIFFERENT aiChatId breaks the burst — two agent runs, idle gap excluded', () => {
    // Run c1 ends 10:05, run c2 starts 10:20 (15m > agentTGap 7m) → two sessions.
    const rows = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:05:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      s('2026-07-04T10:20:00', { source: 'agent', chat: 'c2', kind: 'agent' }),
      s('2026-07-04T10:25:00', { source: 'agent', chat: 'c2', kind: 'agent' }),
    ];
    const r = computeWorkTime(rows); // default agentTGap = 7m
    expect(r.sessions).toHaveLength(2);
    expect(r.sessions.every((x) => x.class === 'agent_only')).toBe(true);
    // The 15m idle gap between the two runs is NOT counted.
    const run1 = 5 * MIN + 5 * MIN + 5 * MIN; // pIn + span + pOut
    expect(r.agentOnlyMs).toBe(2 * run1);
  });

  it('idle pulse (same/null run) is a full activity sample that continues a burst', () => {
    const rows = [
      s('2026-07-04T10:00:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
      // idle flush 4m later, null run id → continues the burst, not a new one
      s('2026-07-04T10:04:00', { source: 'agent', chat: null, kind: 'idle' }),
      s('2026-07-04T10:08:00', { source: 'agent', chat: 'c1', kind: 'agent' }),
    ];
    const r = computeWorkTime(rows);
    expect(r.sessions).toHaveLength(1);
    // burst span 10:00→10:08 (+pIn/pOut) = 8 + 10 = 18m
    expect(r.agentOnlyMs).toBe(18 * MIN);
  });

  it('idle pulse keeps a human writing session visible (not excluded)', () => {
    const rows = [
      s('2026-07-04T10:00:00'),
      s('2026-07-04T10:08:00', { kind: 'idle' }), // pulse within T_gap
      s('2026-07-04T10:15:00'),
    ];
    const r = computeWorkTime(rows);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].class).toBe('work');
    // span 10:00→10:15 + pIn/pOut = 15 + 10 = 25m
    expect(r.workMs).toBe(25 * MIN);
  });

  it('git-source samples are excluded (§10 excludeGit)', () => {
    const rows = [
      s('2026-07-04T10:00:00', { source: 'git', kind: 'boundary' }),
      s('2026-07-04T10:01:00', { source: 'git', kind: 'boundary' }),
    ];
    expect(computeWorkTime(rows).workMs).toBe(0);
    // ...but honoured off:
    expect(
      computeWorkTime(rows, { excludeGit: false }).workMs,
    ).toBeGreaterThan(0);
  });

  it('rejects an invalid config (tGap < pIn + pOut)', () => {
    expect(() =>
      computeWorkTime([s('2026-07-04T10:00:00')], {
        tGap: 5 * MIN,
        pIn: 5 * MIN,
        pOut: 5 * MIN,
      }),
    ).toThrow(/tGap/);
  });
});
