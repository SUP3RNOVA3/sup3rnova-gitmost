import { afterEach, describe, expect, it, vi } from 'vitest';
import { z, ZodError } from 'zod';
import { loadSettingsOrExit } from '../src/engine/config-errors';
import { envSchema } from '../src/engine/settings';

// Companion to test/config-errors.test.ts. That file covers the success path,
// the MISSING-required (undefined -> invalid_type) -> exit branch, and the
// non-ZodError passthrough. This file fills the remaining GAP: the
// INVALID-VALUE branch (config-errors.ts lines ~20, 27-30). A ZodError whose
// issue is a CONSTRAINT violation (bad URL, bad enum, too-short string) is NOT
// a missing key, so it must be routed into the `invalid` bucket and reported
// under the "Invalid value(s)" heading with a `<name>: <message>` line — a
// distinct, operator-facing message from the missing-variable case.
describe('loadSettingsOrExit — invalid-value branch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Stub process.exit so it throws (control stops at the exit point without
  // killing the runner) and capture everything written to stderr. Mirrors the
  // approach in the existing config-errors.test.ts.
  function stubExitAndStderr() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const written = () => writeSpy.mock.calls.map((c) => String(c[0])).join('');
    return { exitSpy, writeSpy, written };
  }

  it('exits(1) and reports an invalid value (bad URL) under "Invalid value(s)"', () => {
    const { exitSpy, written } = stubExitAndStderr();

    // A present-but-invalid DOCMOST_API_URL: the value exists (so it is NOT a
    // missing-key issue), but fails the .url() constraint -> goes to `invalid`.
    expect(() =>
      loadSettingsOrExit(() =>
        envSchema.parse({
          DOCMOST_API_URL: 'not-a-url',
          DOCMOST_EMAIL: 'ops@example.com',
          DOCMOST_PASSWORD: 'hunter2',
          DOCMOST_SPACE_ID: 'space-1',
        }),
      ),
    ).toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = written();
    // The invalid-value heading must appear...
    expect(out).toContain('Invalid value(s)');
    // ...and it must name the offending variable on a `<name>: <message>` line.
    expect(out).toContain('DOCMOST_API_URL:');
    // The header line is always present.
    expect(out).toContain('Configuration error in environment / .env:');
    // It must NOT misreport an invalid value as a missing one.
    expect(out).not.toContain('Missing required variable(s)');
  });

  it('exits(1) and reports an invalid enum value (LOG_LEVEL)', () => {
    const { exitSpy, written } = stubExitAndStderr();

    // All required vars present and valid; only LOG_LEVEL violates the enum.
    expect(() =>
      loadSettingsOrExit(() =>
        envSchema.parse({
          DOCMOST_API_URL: 'https://docs.example.com/api',
          DOCMOST_EMAIL: 'ops@example.com',
          DOCMOST_PASSWORD: 'hunter2',
          DOCMOST_SPACE_ID: 'space-1',
          LOG_LEVEL: 'verbose', // not in ['debug','info','warn','error']
        }),
      ),
    ).toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = written();
    expect(out).toContain('Invalid value(s)');
    expect(out).toContain('LOG_LEVEL:');
    expect(out).not.toContain('Missing required variable(s)');
  });

  it('routes a hand-built constraint-violation ZodError into the invalid bucket', () => {
    const { exitSpy, written } = stubExitAndStderr();

    // Construct the ZodError directly from a min-length violation so the test
    // does not depend on the project schema's exact field set. The issue has a
    // non-empty path (so a variable name is printed) and code "too_small"
    // (NOT invalid_type/undefined), so config-errors.ts classifies it as
    // invalid rather than missing.
    const zerr = new ZodError([
      {
        code: 'too_small',
        minimum: 1,
        type: 'string',
        inclusive: true,
        path: ['DOCMOST_PASSWORD'],
        message: 'String must contain at least 1 character(s)',
      } as z.ZodIssue,
    ]);

    expect(() =>
      loadSettingsOrExit(() => {
        throw zerr;
      }),
    ).toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = written();
    expect(out).toContain('Invalid value(s)');
    expect(out).toContain('DOCMOST_PASSWORD: String must contain at least 1');
    expect(out).not.toContain('Missing required variable(s)');
  });

  it('reports missing AND invalid in their own sections when both occur', () => {
    const { exitSpy, written } = stubExitAndStderr();

    // DOCMOST_API_URL present but invalid (-> invalid section); the three other
    // required vars absent (-> missing section). Confirms the two branches are
    // populated and emitted independently.
    expect(() =>
      loadSettingsOrExit(() =>
        envSchema.parse({
          DOCMOST_API_URL: 'not-a-url',
        }),
      ),
    ).toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const out = written();
    expect(out).toContain('Missing required variable(s)');
    expect(out).toContain('Invalid value(s)');
    expect(out).toContain('DOCMOST_API_URL:');
    expect(out).toContain('DOCMOST_EMAIL');
  });
});
