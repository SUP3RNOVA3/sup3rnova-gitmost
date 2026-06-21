import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadSettingsOrExit } from '../src/engine/config-errors';

describe('loadSettingsOrExit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the factory value and does not exit on success', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    const result = loadSettingsOrExit(() => ({ ok: true }));

    expect(result).toEqual({ ok: true });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints a named-variable message and exits(1) on a ZodError', () => {
    // Mock process.exit to throw so control stops at the exit point, mirroring
    // the real exit-the-process behaviour without killing the test runner.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const writeSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    expect(() =>
      loadSettingsOrExit(() => z.object({ FOO: z.string() }).parse({})),
    ).toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Missing required variable(s)');
    expect(written).toContain('FOO');
  });

  it('propagates a non-ZodError without exiting', () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const boom = new Error('x');

    expect(() =>
      loadSettingsOrExit(() => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
