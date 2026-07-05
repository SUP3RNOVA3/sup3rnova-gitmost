import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { convertProseMirrorToMarkdown } from '../../src/lib/markdown-converter.js';
import { markdownToProseMirror } from '../../src/lib/markdown-to-prosemirror.js';
import { docsCanonicallyEqual } from '../../src/lib/canonicalize.js';

// ---------------------------------------------------------------------------
// #351 committed counterexamples — REAL round-trip bugs surfaced by the flat
// generative probing (attribute level). Each is pinned here as an `it.fails`
// (vitest passes ONLY WHILE the assertion still fails), so that the day the
// underlying src/ bug is fixed, the `it.fails` starts PASSING and vitest turns
// this test RED — forcing us to delete the counterexample and (per the epic
// guardrail) tighten the generator. A bare `it.fails` would ship silent
// corruption, so every case below carries a loud `// BUG #351:` explanation.
//
// These bugs are NOT worked around by weakening any property: the offending
// attribute is kept OUT of the P1/P2 generators (documented in
// attr-arbitraries.ts), and the exact failing document lives here as the
// regression pin. FIXING the bug is a separate, maintainer-approved src/ change.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, '../fixtures/counterexamples');

function loadDoc(file: string): any {
  return JSON.parse(readFileSync(path.join(fixtureDir, file), 'utf8')).doc;
}

describe('#351 counterexamples (known round-trip bugs, pinned as it.fails)', () => {
  // BUG #351: a `column` with a PERCENTAGE width ("50%") is not byte-stable.
  // The column schema parses `data-width` with parseFloat, dropping the '%':
  //   md1 = '...data-width="50%"...'   (first export)
  //   re-import stores width = 50 (number)
  //   md2 = '...data-width="50"...'    (second export)  => md2 !== md1
  // A permanent GS-EDIT-REVERT churn on every git-sync pull. The editor stores
  // column widths as percentages, so this is a genuine defect. The fix is in
  // src/lib/docmost-schema.ts (column.width parseHTML must preserve the unit)
  // and is out of scope for this test-only PR.
  it.fails('column percentage width is byte-stable (P2)', async () => {
    const doc = loadDoc('columns-column-width-percent.json');
    const md1 = convertProseMirrorToMarkdown(doc);
    const doc2 = await markdownToProseMirror(md1);
    const md2 = convertProseMirrorToMarkdown(doc2);
    // This assertion currently FAILS (md2 drops the '%'), which is exactly what
    // `it.fails` expects. When the schema is fixed, it will PASS and flip this
    // test red — our cue to remove the pin.
    expect(md2).toBe(md1);
  });

  // BUG #351: an `orderedList` with a non-1 `start` loses its start number.
  // CommonMark CAN express this ("5." starts the list at 5), but the converter
  // always emits "1." and ignores `attrs.start` (markdown-converter.ts renders
  // `${index + 1}.`; the <ol> HTML path also omits `start`):
  //   doc.start = 5   ->   md1 = "1. alpha"   (start dropped on export)
  //   re-import stores start = 1   =>   docsCanonicallyEqual(rt, doc) === false
  // This is a P1 (semantic round-trip) loss of the SAME class as column.width:
  // representable in markdown, silently dropped by the converter. It is pinned
  // here as the LOUD counterexample rather than being masked as an "accepted
  // normalization" in the generator — per the epic guardrail, deciding
  // accept-vs-fix for a markdown-representable loss is a MAINTAINER call, so this
  // stays a visible known-bug until the maintainer rules on it. The fix would be
  // in src/lib/markdown-converter.ts (emit the start number on the first item)
  // and is out of scope for this test-only PR.
  it.fails('ordered list start number is preserved (P1)', async () => {
    const doc = loadDoc('ordered-list-start.json');
    const md1 = convertProseMirrorToMarkdown(doc);
    const doc2 = await markdownToProseMirror(md1);
    // Currently FAILS: doc2.start === 1 while doc.start === 5. When the converter
    // preserves `start`, this PASSES and flips the test red — remove the pin then.
    expect(docsCanonicallyEqual(doc2, doc)).toBe(true);
  });
});
