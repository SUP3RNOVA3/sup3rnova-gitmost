import {
  hasRepeatedLineRun,
  hasPeriodicTail,
  isDegenerateOutput,
  truncateDegeneratedTail,
  shouldCheckDegeneration,
  DEGENERATION_CHECK_STEP,
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

  // TRIVIAL_MIN_REPEATS boundary (#444 review). The monochar-tail branch fires at
  // EXACTLY 60 identical trailing chars (`run >= TRIVIAL_MIN_REPEATS`), so 59 is
  // clean and 60 trips. These pin the `>=` and MUST fail if the comparison is
  // flipped to `>` (the surviving mutation). The value 60 is HARD-CODED here on
  // purpose: TRIVIAL_MIN_REPEATS is a private constant and the assert must lock
  // the literal boundary the reviewer named, not track a constant edit.
  it('NEGATIVE: 59 identical trailing chars is one below the monochar threshold', () => {
    expect(hasPeriodicTail('x'.repeat(59))).toBe(false);
    expect(isDegenerateOutput('x'.repeat(59))).toBe(false);
  });

  it('POSITIVE: 60 identical trailing chars hits the monochar threshold exactly', () => {
    // Fails if `run >= TRIVIAL_MIN_REPEATS` is mutated to `run > …`.
    expect(hasPeriodicTail('x'.repeat(60))).toBe(true);
    expect(isDegenerateOutput('x'.repeat(60))).toBe(true);
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

/**
 * Throttle + step-boundary reset (#486). The stream keeps a watermark
 * (`lastDegenerationCheckLen`) that is an OFFSET into the accumulated step text.
 * On a step boundary the accumulator resets to '', so the watermark MUST reset to
 * 0 too — otherwise the throttle goes silent for the whole next step. These tests
 * pin the pure decision AND the reset property that ai-chat.service.onStepFinish
 * now enforces.
 */
describe('shouldCheckDegeneration (throttle) + step-boundary reset (#486)', () => {
  it('fires once the text grows a full DEGENERATION_CHECK_STEP past the mark', () => {
    expect(shouldCheckDegeneration(DEGENERATION_CHECK_STEP, 0)).toBe(true);
    expect(shouldCheckDegeneration(DEGENERATION_CHECK_STEP - 1, 0)).toBe(false);
    expect(shouldCheckDegeneration(5000, 3000)).toBe(true); // grew 2000 since mark
    expect(shouldCheckDegeneration(4000, 3000)).toBe(false); // grew only 1000
  });

  it('BUG (no reset): a stale large watermark silences the next step', () => {
    // End of a long step: the watermark sits at 5000. The step ends and the
    // accumulator resets to '' — but if the watermark is NOT reset, a fresh short
    // degenerate burst (length 2000) never triggers a check: 2000 - 5000 < STEP.
    const staleWatermark = 5000;
    const nextStepLen = DEGENERATION_CHECK_STEP; // a fresh 2KB burst
    expect(shouldCheckDegeneration(nextStepLen, staleWatermark)).toBe(false);
  });

  it('FIX (reset to 0): the same short degenerate burst IS checked and detected', () => {
    // onStepFinish now zeroes the watermark, so the fresh burst re-arms the check.
    const resetWatermark = 0;
    const degenerateBurst = 'loadTools.\n'.repeat(300); // real degeneration
    expect(degenerateBurst.length).toBeGreaterThanOrEqual(DEGENERATION_CHECK_STEP);
    // The throttle now fires...
    expect(
      shouldCheckDegeneration(degenerateBurst.length, resetWatermark),
    ).toBe(true);
    // ...and the detector catches the loop that would otherwise stream unchecked.
    expect(isDegenerateOutput(degenerateBurst)).toBe(true);
  });
});
