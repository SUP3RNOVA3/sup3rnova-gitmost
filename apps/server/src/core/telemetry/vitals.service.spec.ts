import { VitalsService } from './vitals.service';
import { MAX_ATTR_LENGTH } from './client-metrics.constants';

// buildRows is pure (no DB access), so a null db is fine here.
const svc = new VitalsService(null as any);

describe('VitalsService.buildRows', () => {
  const WS = 'ws-uuid';

  it('accepts a valid batch and maps whitelisted fields to rows', () => {
    const body = {
      events: [
        { name: 'INP', value: 123.4, rating: 'good', route: '/s/:space/p/:slug' },
        { name: 'editor_tx_ms', value: 12, route: '/s/:space/p/:slug', docSize: 4096 },
      ],
    };
    const rows = svc.buildRows(body, WS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'INP',
      value: 123.4,
      rating: 'good',
      route: '/s/:space/p/:slug',
      attr: null,
      docSize: null,
      workspaceId: WS,
    });
    expect(rows[1].name).toBe('editor_tx_ms');
    expect(rows[1].docSize).toBe(4096);
    expect(rows[1].workspaceId).toBe(WS);
  });

  it('accepts a bare array body', () => {
    const rows = svc.buildRows([{ name: 'LCP', value: 1 }], WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('LCP');
  });

  it('drops events with foreign metric names', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'evil_metric', value: 1 }, { name: 'LCP', value: 2 }] },
      WS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('LCP');
  });

  it('drops events with a non-numeric or missing value', () => {
    const rows = svc.buildRows(
      {
        events: [
          { name: 'CLS', value: 'nan' },
          { name: 'CLS' },
          { name: 'CLS', value: 0.1 },
        ],
      },
      WS,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(0.1);
  });

  it('strips foreign fields and only keeps whitelisted columns', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'TTFB', value: 5, secret: 'drop-me', title: 'my page' }] },
      WS,
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['attr', 'docSize', 'name', 'rating', 'route', 'value', 'workspaceId'].sort(),
    );
    expect((rows[0] as any).secret).toBeUndefined();
    expect((rows[0] as any).title).toBeUndefined();
  });

  it('rejects a rating outside the allowed set (-> null)', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'INP', value: 1, rating: 'terrible' }] },
      WS,
    );
    expect(rows[0].rating).toBeNull();
  });

  it('truncates attr to 120 chars', () => {
    const longAttr = 'a'.repeat(500);
    const rows = svc.buildRows(
      { events: [{ name: 'INP', value: 1, attr: longAttr }] },
      WS,
    );
    expect(rows[0].attr).toHaveLength(MAX_ATTR_LENGTH);
  });

  it('caps the batch at 50 events', () => {
    const events = Array.from({ length: 200 }, () => ({ name: 'CLS', value: 1 }));
    const rows = svc.buildRows({ events }, WS);
    expect(rows).toHaveLength(50);
  });

  it('drops an oversized (>16KB) payload wholesale', () => {
    const events = Array.from({ length: 50 }, () => ({
      name: 'INP',
      value: 1,
      attr: 'x'.repeat(400),
      route: '/s/:space/p/:slug',
    }));
    // Serialised body far exceeds 16KB.
    const rows = svc.buildRows({ events }, WS);
    expect(rows).toHaveLength(0);
  });

  it('returns [] for malformed bodies', () => {
    expect(svc.buildRows(null, WS)).toEqual([]);
    expect(svc.buildRows('nope', WS)).toEqual([]);
    expect(svc.buildRows({ notEvents: 1 }, WS)).toEqual([]);
    expect(svc.buildRows(42, WS)).toEqual([]);
  });

  it('carries a null workspaceId through', () => {
    const rows = svc.buildRows({ events: [{ name: 'LCP', value: 1 }] }, null);
    expect(rows[0].workspaceId).toBeNull();
  });

  it('drops an out-of-int4-range docSize to null without losing the batch', () => {
    const rows = svc.buildRows(
      {
        events: [
          // Garbage docSize overflowing int4 must NOT reject the whole batch:
          // the field is dropped to null and the event is kept.
          { name: 'editor_tx_ms', value: 10, docSize: 9_999_999_999 },
          { name: 'editor_tx_ms', value: 20, docSize: -5 },
          { name: 'editor_tx_ms', value: 30, docSize: 4096 },
        ],
      },
      WS,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].docSize).toBeNull();
    expect(rows[1].docSize).toBeNull();
    expect(rows[2].docSize).toBe(4096);
  });

  it('keeps a docSize exactly at the int4 max', () => {
    const rows = svc.buildRows(
      { events: [{ name: 'editor_tx_ms', value: 1, docSize: 2147483647 }] },
      WS,
    );
    expect(rows[0].docSize).toBe(2147483647);
  });
});
