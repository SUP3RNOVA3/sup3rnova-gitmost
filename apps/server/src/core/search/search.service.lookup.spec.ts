import {
  computeLookupScore,
  escapeLikePattern,
  SearchLookupTier,
} from './search.service';

/**
 * Pure-function coverage for the #443 agent-lookup helpers:
 *  - escapeLikePattern: LIKE-metacharacter escaping so `%`/`_`/`\` are literals
 *    (the acceptance-table requirement that a query of `%` or `_` does NOT match
 *    everything);
 *  - computeLookupScore: the tiered 0..1 ranking score, where a stronger tier
 *    always outranks a weaker one regardless of the in-tier secondary signal.
 *
 * The DB-touching branch (substring UNION FTS, path CTE, snippet window) is
 * covered by the integration spec against the real schema.
 */
describe('escapeLikePattern', () => {
  it('escapes the LIKE metacharacters % _ and \\', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('\\')).toBe('\\\\');
  });

  it('escapes the backslash FIRST so it does not double-escape %/_', () => {
    // Input `\%` must become `\\` + `\%` = `\\\%`, not `\\%`.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
  });

  it('leaves ordinary technical chars (. - / digits) untouched', () => {
    expect(escapeLikePattern('backup-srv.local')).toBe('backup-srv.local');
    expect(escapeLikePattern('10.0.12')).toBe('10.0.12');
    expect(escapeLikePattern('WB-MGE-30D86B')).toBe('WB-MGE-30D86B');
    expect(escapeLikePattern('a/b')).toBe('a/b');
  });

  it('escapes only the metacharacters in a mixed string', () => {
    expect(escapeLikePattern('50%_off.zip')).toBe('50\\%\\_off.zip');
  });

  it('is null/undefined-safe', () => {
    expect(escapeLikePattern(undefined as any)).toBe('');
    expect(escapeLikePattern(null as any)).toBe('');
  });
});

describe('computeLookupScore', () => {
  it('keeps every score within (0, 1]', () => {
    for (const tier of [
      SearchLookupTier.TITLE_EXACT,
      SearchLookupTier.TITLE_SUBSTRING,
      SearchLookupTier.TEXT,
    ]) {
      for (const secondary of [0, 0.001, 1, 100, 1e6]) {
        const s = computeLookupScore({ tier, secondary });
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a stronger tier ALWAYS outranks a weaker tier, whatever the secondary', () => {
    // Weak tier with a huge secondary must still lose to a strong tier with a
    // tiny secondary — tiers dominate.
    const strongLowSecondary = computeLookupScore({
      tier: SearchLookupTier.TITLE_EXACT,
      secondary: 0,
    });
    const weakHighSecondary = computeLookupScore({
      tier: SearchLookupTier.TEXT,
      secondary: 1e9,
    });
    expect(strongLowSecondary).toBeGreaterThan(weakHighSecondary);
  });

  it('within a tier a larger secondary sorts higher', () => {
    const lo = computeLookupScore({
      tier: SearchLookupTier.TEXT,
      secondary: 0.1,
    });
    const hi = computeLookupScore({
      tier: SearchLookupTier.TEXT,
      secondary: 5,
    });
    expect(hi).toBeGreaterThan(lo);
  });

  it('treats a negative/absent secondary as 0', () => {
    const zero = computeLookupScore({ tier: SearchLookupTier.TEXT, secondary: 0 });
    expect(computeLookupScore({ tier: SearchLookupTier.TEXT })).toBe(zero);
    expect(
      computeLookupScore({ tier: SearchLookupTier.TEXT, secondary: -5 }),
    ).toBe(zero);
  });
});
