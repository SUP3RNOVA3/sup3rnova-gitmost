import {
  hasRepeatedLineRun,
  hasPeriodicTail,
  isDegenerateOutput,
  truncateDegeneratedTail,
  REPEATED_LINES_THRESHOLD,
  MIN_PERIOD_REPEATS,
} from './output-degeneration';

/**
 * Unit tests for the token-degeneration detector (#444) — the sole anti-babble
 * guard once the final-step lockdown is OFF. The two rules must fire on real
 * degeneration (the "loadTools." incident, a no-newline repeat) and MUST NOT fire
 * on legitimate long output (edit lists, tables, code).
 */
describe('hasRepeatedLineRun (rule 1: identical-line run)', () => {
  it('POSITIVE: fires on "loadTools.\\n" repeated many times (the incident)', () => {
    const text = 'Here is my plan.\n' + 'loadTools.\n'.repeat(300);
    expect(hasRepeatedLineRun(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });

  it('POSITIVE: fires at exactly the threshold', () => {
    const text = 'x\n'.repeat(REPEATED_LINES_THRESHOLD);
    expect(hasRepeatedLineRun(text)).toBe(true);
  });

  it('NEGATIVE: does NOT fire just below the threshold', () => {
    // threshold-1 identical lines followed by a distinct line.
    const text = 'x\n'.repeat(REPEATED_LINES_THRESHOLD - 1) + 'done\n';
    expect(hasRepeatedLineRun(text)).toBe(false);
  });

  it('NEGATIVE: a long edit list of DISTINCT lines never trips', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) lines.push(`- edited section ${i}: fixed typo`);
    const text = lines.join('\n');
    expect(hasRepeatedLineRun(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a markdown table with blank separators does not trip', () => {
    // Repeated identical rows are unusual, but blank lines break any run.
    const block = ['| a | b |', '| - | - |', '', '| a | b |', ''];
    const text = Array.from({ length: 60 }, () => block.join('\n')).join('\n');
    expect(hasRepeatedLineRun(text)).toBe(false);
  });

  it('NEGATIVE: blank lines do NOT count toward a run', () => {
    const text = '\n'.repeat(100);
    expect(hasRepeatedLineRun(text)).toBe(false);
  });
});

describe('hasPeriodicTail (rule 2: no-newline suffix periodicity)', () => {
  it('POSITIVE: fires on a single char repeated with no newlines', () => {
    const text = 'answer: ' + 'a'.repeat(500);
    expect(hasPeriodicTail(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });

  it('POSITIVE: fires on a multi-char block repeat with no newlines', () => {
    const text = 'prefix ' + 'abcdef'.repeat(100);
    expect(hasPeriodicTail(text)).toBe(true);
  });

  it('POSITIVE: at least MIN_PERIOD_REPEATS repeats of a small block', () => {
    const text = 'go'.repeat(MIN_PERIOD_REPEATS);
    expect(hasPeriodicTail(text)).toBe(true);
  });

  it('NEGATIVE: prose does not look periodic', () => {
    const text =
      'The quick brown fox jumps over the lazy dog while the sun sets slowly ' +
      'behind the distant mountains and the river winds through the valley below.';
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a long code block is not flagged', () => {
    const code = `
function compute(values) {
  let total = 0;
  for (const v of values) {
    total += v * 2;
  }
  return total / values.length;
}
export const helper = (x) => x + 1;
const config = { retries: 3, timeout: 5000, backoff: 'exp' };
`.repeat(3);
    expect(isDegenerateOutput(code)).toBe(false);
  });

  it('NEGATIVE: a short string well under the repeat count is safe', () => {
    expect(hasPeriodicTail('ababab')).toBe(false);
  });

  // Regression (#444): a trivial single-char period (p===1) must NOT flag
  // legitimate divider/underline/whitespace runs. These are common in real
  // model output and previously false-positived at ~20 identical chars, aborting
  // the run and truncating output. They must all be treated as clean.
  it('NEGATIVE: a markdown horizontal rule is not flagged', () => {
    const text = 'text\n' + '-'.repeat(40);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a setext heading underline is not flagged', () => {
    const text = 'Title\n' + '='.repeat(30);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: a box-drawing divider with no trailing newline is not flagged', () => {
    const text = 'done ' + '─'.repeat(50);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  it('NEGATIVE: trailing spaces are not flagged', () => {
    const text = 'answer' + ' '.repeat(40);
    expect(hasPeriodicTail(text)).toBe(false);
    expect(isDegenerateOutput(text)).toBe(false);
  });

  // Positive counterparts: a GENUINE single-char runaway (hundreds+ of repeats)
  // and the real incident (period>=2, "loadTools." ×N) must still fire.
  it('POSITIVE: a genuine single-char runaway is still flagged', () => {
    const text = 'x'.repeat(5000);
    expect(hasPeriodicTail(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });

  it('POSITIVE: the "loadTools." incident (period>=2) is still flagged', () => {
    const text = 'loadTools.'.repeat(500);
    expect(hasPeriodicTail(text)).toBe(true);
    expect(isDegenerateOutput(text)).toBe(true);
  });
});

describe('truncateDegeneratedTail', () => {
  it('collapses a repeated-line loop to a few reps + marker', () => {
    const text = 'plan\n' + 'loadTools.\n'.repeat(20000);
    const out = truncateDegeneratedTail(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('output truncated');
    // Keeps the leading context and a few loop reps.
    expect(out).toContain('plan');
    expect((out.match(/loadTools\./g) ?? []).length).toBeLessThan(10);
  });

  it('collapses a no-newline periodic loop to a few blocks + marker', () => {
    const text = 'answer: ' + 'xy'.repeat(50000);
    const out = truncateDegeneratedTail(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('output truncated');
    expect(out).toContain('answer:');
  });

  it('returns non-degenerate text unchanged (by identity)', () => {
    const text = 'A perfectly normal, finished assistant answer.';
    expect(truncateDegeneratedTail(text)).toBe(text);
  });
});
