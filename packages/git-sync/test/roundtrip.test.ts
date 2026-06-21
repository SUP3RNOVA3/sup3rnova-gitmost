import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
} from 'docmost-client';

// Resolve the fixture relative to this test file so the test is CWD-independent.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample-doc.json');

describe('round-trip idempotency (SPEC §11)', () => {
  it('markdown is byte-stable across export -> import -> export', async () => {
    const doc = JSON.parse(await readFile(FIXTURE, 'utf8'));

    // export -> import -> export
    const md1 = convertProseMirrorToMarkdown(doc);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);

    // The property git actually needs: a second export reproduces the first
    // byte-for-byte. We intentionally do NOT deep-equal doc vs doc2 — the
    // converter reconstructs schema default attrs (e.g. indent:null), a known
    // SPEC §11 divergence that does not affect markdown stability.
    expect(md2).toBe(md1);
  });
});
