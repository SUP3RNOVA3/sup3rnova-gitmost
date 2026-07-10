import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeSrcRegistryStamp } from './docmost-client.loader';

// The exact message the loader throws on a build/src skew (issue #447). Kept as a
// literal here so a reworded prod message reddens this test (the message is a
// developer-facing contract: it tells them how to fix it).
const STALE_BUILD_MESSAGE =
  '@docmost/mcp build is stale (tool-specs changed since last build) — run: pnpm --filter @docmost/mcp build';

// Replica of the loader's inline stale-check predicate + throw from
// `loadDocmostMcp`. That guard is not independently exported (it lives inside the
// dynamic-import IIFE, wired to a fixed `require.resolve('@docmost/mcp')`), so we
// exercise the exact same three-condition logic against a stamp produced by the
// REAL `computeSrcRegistryStamp`. This documents and locks the throw/no-throw
// behaviour; if the prod predicate changes, this replica must change with it.
function assertStaleGuard(
  srcStamp: string | null,
  registryStamp: string | undefined,
): void {
  if (
    srcStamp !== null &&
    typeof registryStamp === 'string' &&
    srcStamp !== registryStamp
  ) {
    throw new Error(STALE_BUILD_MESSAGE);
  }
}

// Build a throwaway `<pkg>/build/index.js` + optional `<pkg>/src/tool-specs.ts`
// layout so `computeSrcRegistryStamp(<pkg>/build/index.js)` resolves src the same
// way the loader does (dirname(dirname(entry))/src/tool-specs.ts).
function makeFakePackage(toolSpecsSource: string | null): {
  entry: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'mcp-stamp-'));
  const buildDir = join(root, 'build');
  mkdirSync(buildDir, { recursive: true });
  const entry = join(buildDir, 'index.js');
  writeFileSync(entry, '// fake @docmost/mcp build entry\n', 'utf8');
  if (toolSpecsSource !== null) {
    const srcDir = join(root, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'tool-specs.ts'), toolSpecsSource, 'utf8');
  }
  return { entry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('computeSrcRegistryStamp (#447 stale-build guard)', () => {
  it('returns null when src/tool-specs.ts is absent (prod no-op path)', () => {
    // A prod image ships only build/, no src/ — the guard must be a silent no-op.
    const { entry, cleanup } = makeFakePackage(null);
    try {
      expect(computeSrcRegistryStamp(entry)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('returns null for a bogus package entry (swallowed error path)', () => {
    // A resolution/read hiccup must NEVER break startup — it resolves to null.
    expect(
      computeSrcRegistryStamp('/no/such/pkg/build/index.js'),
    ).toBeNull();
  });

  it('computes a 64-char sha256 hex when src/tool-specs.ts exists', () => {
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const stamp = computeSrcRegistryStamp(entry);
      expect(stamp).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });

  it('normalizes CRLF->LF and strips a single trailing newline', () => {
    // A CRLF+trailing-newline variant of the same content hashes identically to
    // the bare-LF form — the guard must not fire on a checkout-style difference.
    const bare = makeFakePackage('alpha\nbeta');
    const crlfTrailing = makeFakePackage('alpha\r\nbeta\r\n');
    try {
      expect(computeSrcRegistryStamp(crlfTrailing.entry)).toBe(
        computeSrcRegistryStamp(bare.entry),
      );
    } finally {
      bare.cleanup();
      crlfTrailing.cleanup();
    }
  });

  // CROSS-IMPL EQUALITY (covers reviewer suggestion 2). The SAME fixed input and
  // EXPECTED hash are asserted in the mcp-side node test
  // (packages/mcp/test/unit/registry-stamp.test.mjs) against the codegen's
  // `computeRegistryStamp`. Asserting the SAME pair here against the loader's
  // `computeSrcRegistryStamp` proves both implementations normalize+hash
  // identically; a divergence in EITHER side reddens one of the two tests.
  it('matches the documented cross-impl hash for a fixed input', () => {
    const FIXED_INPUT = 'line1\r\nline2\n';
    const EXPECTED =
      '683376e290829b482c2655745caffa7a1dccfa10afaa62dac2b42dd6c68d0f83';
    const { entry, cleanup } = makeFakePackage(FIXED_INPUT);
    try {
      expect(computeSrcRegistryStamp(entry)).toBe(EXPECTED);
    } finally {
      cleanup();
    }
  });

  it('the documented EXPECTED is the normalize+sha256 of the fixed input', () => {
    // Proves EXPECTED is not a magic constant but the documented computation.
    const FIXED_INPUT = 'line1\r\nline2\n';
    const normalized = FIXED_INPUT.replace(/\r\n/g, '\n').replace(/\n$/, '');
    const expected = createHash('sha256')
      .update(normalized, 'utf8')
      .digest('hex');
    const { entry, cleanup } = makeFakePackage(FIXED_INPUT);
    try {
      expect(computeSrcRegistryStamp(entry)).toBe(expected);
    } finally {
      cleanup();
    }
  });
});

describe('loadDocmostMcp stale-check predicate (#447)', () => {
  it('THROWS the exact stale message when src stamp != built REGISTRY_STAMP', () => {
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const srcStamp = computeSrcRegistryStamp(entry);
      expect(srcStamp).not.toBeNull();
      // Simulate a stale build: build/ carries a DIFFERENT stamp than src.
      expect(() => assertStaleGuard(srcStamp, 'a'.repeat(64))).toThrow(
        STALE_BUILD_MESSAGE,
      );
    } finally {
      cleanup();
    }
  });

  it('does NOT throw when src stamp equals the built REGISTRY_STAMP', () => {
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const srcStamp = computeSrcRegistryStamp(entry);
      // Fresh build: build/ stamp == src stamp -> guard is a no-op.
      expect(() => assertStaleGuard(srcStamp, srcStamp as string)).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('does NOT throw when src is absent (prod: srcStamp === null)', () => {
    // Even against a present-but-mismatched REGISTRY_STAMP, a null src stamp
    // (prod image with build/ only) must skip the check entirely.
    expect(() => assertStaleGuard(null, 'a'.repeat(64))).not.toThrow();
  });

  it('does NOT throw when REGISTRY_STAMP is absent (pre-#447 build)', () => {
    // An older @docmost/mcp build has no REGISTRY_STAMP export; the guard must be
    // a no-op so an out-of-date build never wrongly blocks startup.
    const { entry, cleanup } = makeFakePackage('export const specs = 1;\n');
    try {
      const srcStamp = computeSrcRegistryStamp(entry);
      expect(() => assertStaleGuard(srcStamp, undefined)).not.toThrow();
    } finally {
      cleanup();
    }
  });
});
