import type { ModelMessage } from 'ai';
import {
  resolveReplayBudget,
  resolveEffectiveReplayThreshold,
  isContextOverflowError,
  estimateMessagesTokens,
  trimHistoryForReplay,
  REPLAY_BUDGET_DEFAULT_TOKENS,
  REPLAY_MIN_FLOOR_TOKENS,
  REPLAY_TRUNCATION_MARKER,
  REPLAY_TURN_COLLAPSED_MARKER,
} from './history-budget';

describe('resolveEffectiveReplayThreshold (#520 iterative escalation)', () => {
  // The escalation table: each consecutive overflow (k) deepens the cut by 0.5×.
  it('scales the base by 0.5**k, flooring (not rounding) fractional tokens', () => {
    const base = 100_000;
    expect(resolveEffectiveReplayThreshold(base, 0)).toBe(base); // k=0: unchanged
    expect(resolveEffectiveReplayThreshold(base, 1)).toBe(50_000); // 0.5×
    expect(resolveEffectiveReplayThreshold(base, 2)).toBe(25_000); // 0.25×
    expect(resolveEffectiveReplayThreshold(base, 3)).toBe(12_500); // 0.125×
    // Floors, not rounds.
    expect(resolveEffectiveReplayThreshold(99_999, 1)).toBe(49_999);
  });

  it('passes a null base (trimming OFF) through unchanged for any k', () => {
    for (const k of [0, 1, 2, 5, 100]) {
      expect(resolveEffectiveReplayThreshold(null, k)).toBeNull();
    }
  });

  // The crux of #520: convergence. A large k is clamped at REPLAY_MIN_FLOOR_TOKENS,
  // so the escalation CONVERGES to a small-but-usable budget instead of trimming to
  // zero — and, unlike the old fixed 0.5× that stuck at 50k, it drops far enough to
  // fit a small real model window.
  it('clamps a large k at the floor (converges, never below)', () => {
    const base = 100_000;
    for (const k of [4, 6, 10, 50, 200]) {
      const t = resolveEffectiveReplayThreshold(base, k) as number;
      expect(t).toBe(REPLAY_MIN_FLOOR_TOKENS);
      expect(t).toBeGreaterThanOrEqual(REPLAY_MIN_FLOOR_TOKENS);
    }
  });

  // Residual-brick regression (#520): flat-default base 100k, real window ~40k. The
  // OLD fixed single 0.5× stuck at 50k > 40k forever (re-overflows every turn — the
  // brick). The iterative cut drops BELOW 40k after a couple more consecutive
  // overflows, so the history finally fits and the chat un-bricks.
  it('un-bricks: escalation drops below a small real window the fixed 0.5× never could', () => {
    const base = 100_000;
    const realWindow = 40_000;
    // The old terminal state: 0.5× = 50k, still above the window.
    expect(resolveEffectiveReplayThreshold(base, 1)).toBeGreaterThan(realWindow);
    // Escalation converges under the window.
    const converged = [2, 3, 4, 5].some(
      (k) => (resolveEffectiveReplayThreshold(base, k) as number) < realWindow,
    );
    expect(converged).toBe(true);
    // MUTATION SENTINEL: reverting `** k` to `** 1` (fixed 0.5×) makes every k yield
    // 50k, so `converged` above would be FALSE and this test reddens. Removing the
    // floor reddens the clamp test instead.
  });

  // The floor never RAISES a legitimately small configured budget above itself
  // (min(floor, base)); doing so would re-overflow the very small window it was set
  // for. So a base BELOW the floor is passed through unchanged and never inflated.
  it('never inflates a small configured budget above itself', () => {
    const small = 5_000; // below REPLAY_MIN_FLOOR_TOKENS
    expect(resolveEffectiveReplayThreshold(small, 0)).toBe(small);
    for (const k of [1, 2, 3, 10]) {
      const t = resolveEffectiveReplayThreshold(small, k) as number;
      expect(t).toBeLessThanOrEqual(small);
    }
  });
});

describe('resolveReplayBudget', () => {
  it('uses floor(0.7 x window) for a configured window (no cap)', () => {
    // 0.7 x 60k = 42k
    expect(resolveReplayBudget(60_000)).toEqual({
      thresholdTokens: 42_000,
      usedDefault: false,
    });
    // 0.7 x 1M = 700k — NOT capped (anti-brick vs the window, not a cost limiter).
    expect(resolveReplayBudget(1_000_000)).toEqual({
      thresholdTokens: 700_000,
      usedDefault: false,
    });
  });

  it('accepts the raw ::text stored form', () => {
    expect(resolveReplayBudget('60000').thresholdTokens).toBe(42_000);
  });

  // The crux (#490): a chat with NO context window configured must STILL be
  // budgeted — those are exactly the installs that hit terminal overflow.
  it('applies the flat default when the window is unset/empty', () => {
    expect(resolveReplayBudget(undefined)).toEqual({
      thresholdTokens: REPLAY_BUDGET_DEFAULT_TOKENS,
      usedDefault: true,
    });
    expect(resolveReplayBudget('')).toEqual({
      thresholdTokens: REPLAY_BUDGET_DEFAULT_TOKENS,
      usedDefault: true,
    });
    expect(resolveReplayBudget('   ')).toEqual({
      thresholdTokens: REPLAY_BUDGET_DEFAULT_TOKENS,
      usedDefault: true,
    });
  });

  it('treats an explicit 0 as the off-switch (distinct from unset)', () => {
    expect(resolveReplayBudget(0)).toEqual({
      thresholdTokens: null,
      usedDefault: false,
    });
    expect(resolveReplayBudget('0')).toEqual({
      thresholdTokens: null,
      usedDefault: false,
    });
  });

  it('falls back to the default on a negative/garbage value', () => {
    expect(resolveReplayBudget(-5).usedDefault).toBe(true);
    expect(resolveReplayBudget('abc').usedDefault).toBe(true);
  });
});

describe('isContextOverflowError', () => {
  it('classifies a real provider 400 context-overflow shape', () => {
    // OpenAI-compatible shape.
    expect(
      isContextOverflowError({
        statusCode: 400,
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 214000 tokens. Please reduce the length of the messages.",
      }),
    ).toBe(true);
    // Anthropic-style wording.
    expect(
      isContextOverflowError({
        status: 400,
        message: 'prompt is too long: 250000 tokens > 200000 maximum',
      }),
    ).toBe(true);
    // Nested body + string status.
    expect(
      isContextOverflowError({
        response: { status: '400' },
        message: 'input is too long for the requested model',
      }),
    ).toBe(true);
    // Error instance with the cause carrying the body.
    const e = new Error('Bad request');
    (e as any).statusCode = 400;
    (e as any).cause = new Error('maximum context window exceeded');
    expect(isContextOverflowError(e)).toBe(true);
  });

  it('does NOT classify unrelated 400s or auth/rate-limit errors', () => {
    expect(
      isContextOverflowError({ statusCode: 400, message: 'invalid tool schema' }),
    ).toBe(false);
    expect(
      isContextOverflowError({
        statusCode: 429,
        message: 'context length exceeded but rate limited',
      }),
    ).toBe(false);
    expect(isContextOverflowError({ statusCode: 500, message: 'server error' })).toBe(
      false,
    );
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError('some random string')).toBe(false);
  });
});

// Helpers to build ModelMessage fixtures in the ai@6 shape.
const userMsg = (text: string): ModelMessage =>
  ({ role: 'user', content: [{ type: 'text', text }] }) as ModelMessage;
const assistantMsg = (
  text: string,
  toolCallId?: string,
  toolName?: string,
): ModelMessage =>
  ({
    role: 'assistant',
    content: [
      { type: 'text', text },
      ...(toolCallId
        ? [{ type: 'tool-call', toolCallId, toolName, input: {} }]
        : []),
    ],
  }) as ModelMessage;
const toolMsg = (
  toolCallId: string,
  toolName: string,
  value: unknown,
): ModelMessage =>
  ({
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId, toolName, output: { type: 'json', value } },
    ],
  }) as ModelMessage;

describe('trimHistoryForReplay', () => {
  it('null budget disables trimming (returns the same reference)', () => {
    const msgs = [userMsg('hi'), assistantMsg('yo')];
    const r = trimHistoryForReplay(msgs, null);
    expect(r.trimmed).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it('leaves history under budget untouched (same reference)', () => {
    const msgs = [userMsg('hi'), assistantMsg('a short answer')];
    const r = trimHistoryForReplay(msgs, 100_000);
    expect(r.trimmed).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  it('truncates OLD tool outputs but keeps recent turns full', () => {
    const big = 'X'.repeat(40_000); // ~16k tokens on its own
    const msgs: ModelMessage[] = [];
    // 6 OLD turns (indices 0..5), each with a huge tool output.
    for (let i = 0; i < 6; i++) {
      msgs.push(userMsg(`old q${i}`));
      msgs.push(assistantMsg('looking', `c${i}`, 'getPage'));
      msgs.push(toolMsg(`c${i}`, 'getPage', { body: big }));
      msgs.push(assistantMsg(`old a${i}`));
    }
    // 3 small recent turns, then the CURRENT turn with its own huge tool output.
    // With REPLAY_KEEP_RECENT_TURNS=4 the last 4 user-turns stay full, so only
    // these small recent turns + the current big one are kept full; the 6 old
    // turns above fall in the trim region.
    for (let i = 0; i < 3; i++) {
      msgs.push(userMsg(`recent q${i}`));
      msgs.push(assistantMsg(`recent a${i}`));
    }
    msgs.push(userMsg('current q'));
    msgs.push(assistantMsg('looking', 'cR', 'getPage'));
    msgs.push(toolMsg('cR', 'getPage', { body: big }));
    msgs.push(assistantMsg('current a'));

    // Budget large enough that phase-1 tool truncation alone brings it under.
    const r = trimHistoryForReplay(msgs, 30_000);
    expect(r.trimmed).toBe(true);
    const flat = JSON.stringify(r.messages);
    // The CURRENT turn's tool output survives in full.
    expect(flat).toContain(big);
    // Old outputs were truncated with the marker.
    expect(flat).toContain(REPLAY_TRUNCATION_MARKER);
    // Phase 1 sufficed: the oldest turns were NOT collapsed.
    expect(flat).not.toContain(REPLAY_TURN_COLLAPSED_MARKER);
    expect(estimateMessagesTokens(r.messages)).toBeLessThan(
      estimateMessagesTokens(msgs),
    );
  });

  it('collapses the oldest turns when tool truncation is not enough', () => {
    // Many turns with LARGE assistant TEXT (not tool output) so phase 1 can't help.
    const bigText = 'слово '.repeat(8_000); // large Cyrillic text per turn
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push(assistantMsg(bigText));
    }
    const r = trimHistoryForReplay(msgs, 30_000);
    expect(r.trimmed).toBe(true);
    // Oldest turns collapsed; result fits (best-effort) and is much smaller.
    expect(estimateMessagesTokens(r.messages)).toBeLessThan(
      estimateMessagesTokens(msgs),
    );
    // The LAST turn's text is preserved in full (recent turns stay full).
    expect(JSON.stringify(r.messages[r.messages.length - 1])).toContain(bigText);
  });

  it('is deterministic / byte-stable for identical inputs', () => {
    const big = 'Y'.repeat(30_000);
    const build = (): ModelMessage[] => {
      const m: ModelMessage[] = [];
      for (let i = 0; i < 10; i++) {
        m.push(userMsg(`q${i}`));
        m.push(assistantMsg('t', `c${i}`, 'getPage'));
        m.push(toolMsg(`c${i}`, 'getPage', { body: big }));
      }
      return m;
    };
    const a = trimHistoryForReplay(build(), 15_000);
    const b = trimHistoryForReplay(build(), 15_000);
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
  });

  it('never leaves an unpaired tool-call after collapsing (balanced history)', () => {
    const big = 'Z'.repeat(40_000);
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push(userMsg(`q${i}`));
      msgs.push(assistantMsg('t', `c${i}`, 'getPage'));
      msgs.push(toolMsg(`c${i}`, 'getPage', { body: big }));
    }
    const r = trimHistoryForReplay(msgs, 8_000);
    // Count tool-call vs tool-result parts in the trimmed output.
    let calls = 0;
    let results = 0;
    for (const m of r.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content as Array<{ type?: string }>) {
        if (p.type === 'tool-call') calls++;
        if (p.type === 'tool-result' || p.type === 'tool-error') results++;
      }
    }
    // Every surviving tool-call has a surviving result (collapsing drops BOTH).
    expect(calls).toBe(results);
    // Collapsed turns carry the marker.
    expect(JSON.stringify(r.messages)).toContain(REPLAY_TURN_COLLAPSED_MARKER);
  });

  it('respects the provider fact: under-budget contextTokens skips trimming', () => {
    const big = 'W'.repeat(60_000);
    const msgs = [
      userMsg('q'),
      assistantMsg('t', 'c1', 'getPage'),
      toolMsg('c1', 'getPage', { body: big }),
    ];
    // char-estimate is high, but the provider says we are well under budget.
    const r = trimHistoryForReplay(msgs, 100_000, 5_000);
    expect(r.trimmed).toBe(false);
    expect(r.messages).toBe(msgs);
  });
});
