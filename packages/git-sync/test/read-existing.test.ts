import { describe, expect, it } from 'vitest';
import { readExisting } from '../src/engine/pull';

// R-Pull-1 (test-strategy report §5): `readExisting` now takes injectable IO
// (`listTracked` / `readFile`), so its parsing + skip rules are unit-testable
// without a real git repo or filesystem. These tests pass fakes only — no git,
// no fs, no network.

/** Build a valid self-contained file with a `docmost:meta` block. */
function withMeta(meta: Record<string, unknown>, body = '# Title\nbody\n'): string {
  return `<!-- docmost:meta\n${JSON.stringify(meta)}\n-->\n\n${body}`;
}

/** A fake `readFile` backed by an in-memory map (rejects on a missing key). */
function fakeReadFile(files: Record<string, string>) {
  return async (rel: string): Promise<string> => {
    if (!(rel in files)) {
      throw Object.assign(new Error(`ENOENT: ${rel}`), { code: 'ENOENT' });
    }
    return files[rel];
  };
}

describe('readExisting (R-Pull-1, injected IO)', () => {
  it('recovers { pageId, relPath } for valid tracked files', async () => {
    const files = {
      'Space/A.md': withMeta({ version: 1, pageId: 'p1', title: 'A' }),
      'Space/Sub/B.md': withMeta({ version: 1, pageId: 'p2', title: 'B' }),
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([
      { pageId: 'p1', relPath: 'Space/A.md' },
      { pageId: 'p2', relPath: 'Space/Sub/B.md' },
    ]);
  });

  it('SKIPS a file with no docmost:meta block (plain hand-written markdown)', async () => {
    const files = {
      'tracked.md': withMeta({ version: 1, pageId: 'p1' }),
      'stray.md': '# Just a hand-written note\n\nNo meta here.\n',
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    // Only the engine-tracked file (with a pageId) survives.
    expect(result).toEqual([{ pageId: 'p1', relPath: 'tracked.md' }]);
  });

  it('SKIPS a file whose meta has no pageId', async () => {
    const files = {
      'has-id.md': withMeta({ version: 1, pageId: 'keep' }),
      'no-id.md': withMeta({ version: 1, title: 'untitled', slugId: 's' }),
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([{ pageId: 'keep', relPath: 'has-id.md' }]);
  });

  it('SKIPS a file with an unparseable (invalid-JSON) meta block, does not throw', async () => {
    // Invalid JSON inside the meta block makes parseDocmostMarkdown throw; the
    // skip-rule must swallow it and treat the file as not-engine-tracked.
    const files = {
      'good.md': withMeta({ version: 1, pageId: 'good' }),
      'broken.md': '<!-- docmost:meta\n{ this is : not, json }\n-->\n\nbody\n',
    };
    const result = await readExisting({
      listTracked: async () => Object.keys(files),
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([{ pageId: 'good', relPath: 'good.md' }]);
  });

  it('does NOT throw when readFile REJECTS (tracked but missing) — treats it as skipped', async () => {
    const files = {
      'present.md': withMeta({ version: 1, pageId: 'present' }),
      // "ghost.md" is listed as tracked but absent from the file map -> reject.
    };
    const result = await readExisting({
      listTracked: async () => ['present.md', 'ghost.md'],
      readFile: fakeReadFile(files),
    });
    // The rejection is swallowed; the present file still comes through.
    expect(result).toEqual([{ pageId: 'present', relPath: 'present.md' }]);
  });

  it('returns an empty list when nothing is tracked', async () => {
    const result = await readExisting({
      listTracked: async () => [],
      readFile: async () => {
        throw new Error('should not be called');
      },
    });
    expect(result).toEqual([]);
  });

  it('combines all skip rules in one listing (only the valid files survive)', async () => {
    const files = {
      'ok1.md': withMeta({ version: 1, pageId: 'a' }),
      'no-meta.md': 'plain\n',
      'no-id.md': withMeta({ version: 1, title: 'x' }),
      'broken.md': '<!-- docmost:meta\n{bad\n-->\nbody\n',
      'ok2.md': withMeta({ version: 1, pageId: 'b' }),
      // missing.md rejects on read.
    };
    const result = await readExisting({
      listTracked: async () => [...Object.keys(files), 'missing.md'],
      readFile: fakeReadFile(files),
    });
    expect(result).toEqual([
      { pageId: 'a', relPath: 'ok1.md' },
      { pageId: 'b', relPath: 'ok2.md' },
    ]);
  });
});
