/**
 * Schema-DERIVED attribute-state fast-check arbitraries (#351, PR 1).
 *
 * This GENERALIZES the #350 stability-matrix helper (roundtrip-stability.helper.ts)
 * to fast-check. Where that helper sweeps a HAND-WRITTEN 2-state matrix for one
 * node spec, this module reads the attribute list straight from
 * `schema.nodes[type].spec.attrs` (never a hand list) and, per attribute,
 * generates over the FOUR states the issue calls for:
 *
 *   - `absent`      : the attribute is OMITTED entirely (the empty-string-vs-
 *                     absent churn class the #350 fix targets).
 *   - `default`     : the schema default value, authored explicitly.
 *   - `nonDefault`  : a representative legal non-default value.
 *   - `degenerate`  : `""` for strings, `0`/negative for numbers, the flipped
 *                     value for booleans.
 *
 * ── Why a per-attribute override table ──────────────────────────────────────
 * Everything that CAN be derived generically from the default's runtime type is
 * (booleans flip; the degenerate value follows the runtime type). But two facts
 * force a small, DOCUMENTED override table:
 *
 *  1. CONSTRAINED domains the schema does not encode. `image.align ∈
 *     {left,center,right}`, `heading.level ∈ 1..6`, `callout.type ∈
 *     {info,success,warning,danger}`, `columns.layout`, table-cell `align`,
 *     `status.color`, `orderedList.start ≥ 1`, etc. A generic "default + 1"
 *     would emit an ILLEGAL value, so these get an explicit legal domain.
 *  2. ROUND-TRIP-safety, established EMPIRICALLY by probing the live converter
 *     (the classification captured in flat-roundtrip.property.test.ts). A frozen
 *     attribute falls into ONE of TWO explicitly-distinguished classes — never a
 *     silent "it just doesn't round-trip":
 *
 *       (a) ACCEPTED LIMITATION — the attribute has NO markdown representation,
 *           so the loss is inherent to targeting markdown, not a converter
 *           defect. GFM/CommonMark simply cannot encode it. These: `paragraph`/
 *           `heading` `indent`, `callout.icon`, `orderedList.type` (a/A/i
 *           markers), table `colspan`/`rowspan`/`colwidth`/`backgroundColor(Name)`
 *           (GFM tables are span-less/style-less). Each is tagged
 *           `// ACCEPTED:` inline. Freezing them is correct — there is nothing to
 *           preserve in the target format.
 *
 *       (b) PINNED BUG — the attribute IS representable in markdown but the
 *           converter drops it anyway (a real defect). These are NOT silently
 *           frozen: each is captured as a LOUD `it.fails` counterexample in
 *           test/fixtures/counterexamples/ + counterexamples.test.ts, and the
 *           freeze here only keeps the P1/P2 union green until a MAINTAINER rules
 *           on accept-vs-fix (the epic guardrail reserves that call). These:
 *           `column.width` (parseFloat drops `%`), `orderedList.start` (non-1
 *           start renders as `1.`). Tagged `// PINNED-BUG:` inline.
 *       - Several non-null-default attrs are MATERIALIZED on import but are not
 *         in canonicalize's KNOWN_DEFAULTS (`callout.type`, `status.color`,
 *         table `colspan`/`rowspan`, `columns.layout`/`widthMode`,
 *         `embed.width`/`height`, `heading.level`, `taskItem.checked`,
 *         `details.open`, `subpages.recursive`, `orderedList.start`). If left
 *         `absent` they re-materialize as a non-canonical default and diverge
 *         under P1. We mark them `always` so they are authored explicitly.
 *       - The documented numeric→string coercion set (`width height size
 *         aspectRatio`) is generated as STRINGS for the media family (a stored
 *         number re-parses as a string), EXCEPT `embed.width/height` which the
 *         embed schema keeps numeric — handled per-attr.
 *
 * Both PINNED-BUG attrs (`column.width` P2 churn, `orderedList.start` P1 loss)
 * are captured as committed `it.fails` counterexamples — NOT hidden here.
 */
import fc from 'fast-check';
import { getSchema } from '@tiptap/core';
import { docmostExtensions } from '../../src/lib/index.js';
import { phraseArb, letterPhraseArb, urlArb } from './text-arbitraries.js';

/** The exact ProseMirror schema the converter targets. */
export const schema = getSchema(docmostExtensions as any);

/** Sentinel: this attribute is OMITTED (the `absent` state). */
export const ABSENT = Symbol('ABSENT');

/** The documented numeric→string coercion set (issue + roundtrip-stability.helper). */
export const NUMERIC_STRING_ATTRS = ['width', 'height', 'size', 'aspectRatio'];

/** Read the schema default for every attribute of a node type. */
export function schemaAttrDefaults(type: string): Record<string, unknown> {
  const specAttrs = (schema.nodes[type]?.spec?.attrs ?? {}) as Record<
    string,
    { default: unknown }
  >;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(specAttrs)) out[k] = v.default;
  return out;
}

/** Attribute names for a node type, straight from the schema (never hand-listed). */
export function schemaAttrNames(type: string): string[] {
  return Object.keys((schema.nodes[type]?.spec?.attrs ?? {}) as object);
}

/**
 * Per-attribute policy. Everything unlisted falls back to a generic policy:
 *   - a BOOLEAN default is fuzzable (its non-default is the flipped value);
 *   - any other default is `frozen` (only `absent`/`default` are generated) so
 *     we never invent an unverified non-default that might not round-trip.
 * Listed attrs override this with a legal `arb` domain and/or flags.
 */
interface AttrPolicy {
  /** Arbitrary for the `nonDefault` state's value. */
  arb?: fc.Arbitrary<unknown>;
  /** Value for the `degenerate` state (fuzz mode only). Omit to skip degenerate. */
  degen?: unknown;
  /** Never emit `absent` — the attr must be authored (materialized default class). */
  always?: boolean;
  /** Never emit the schema default value (required-ish attrs like `src`). Implies always. */
  noDefault?: boolean;
  /** Never emit non-default/degenerate — attr has no md representation or churns. */
  frozen?: boolean;
}

const num = (...xs: number[]) => fc.constantFrom(...xs);
const str = (...xs: string[]) => fc.constantFrom(...xs);
const widthStr = str('120', '320', '640');

// The documented override table, keyed `type.attr`. Every entry is grounded in
// the empirical converter probe (see flat-roundtrip.property.test.ts header).
const OVERRIDES: Record<string, AttrPolicy> = {
  // ── block text containers ────────────────────────────────────────────────
  // 'left' is the IMPLICIT default alignment: the converter drops it on export
  // (empirically confirmed), so it never round-trips. Only center/right/justify
  // carry through the `<!--attrs {textAlign}-->` comment.
  'paragraph.textAlign': { arb: str('center', 'right', 'justify') },
  'paragraph.indent': { frozen: true }, // ACCEPTED: no md representation
  'heading.level': { always: true, arb: num(2, 3, 4, 5, 6) },
  'heading.textAlign': { arb: str('center', 'right', 'justify') },
  'heading.indent': { frozen: true }, // ACCEPTED: no md representation
  // ── lists ────────────────────────────────────────────────────────────────
  // PINNED-BUG: markdown CAN express a non-1 start ("5."), but the converter
  // renders "1." and drops it -> P1 loss. See counterexamples.test.ts
  // (ordered-list-start.json). Frozen only until the maintainer rules accept-vs-fix.
  'orderedList.start': { always: true, frozen: true },
  'orderedList.type': { frozen: true }, // ACCEPTED: a/A/i markers not expressible in GFM
  'taskItem.checked': { always: true, arb: fc.constant(true) }, // boolean, default false
  // ── codeBlock ────────────────────────────────────────────────────────────
  'codeBlock.language': { arb: str('js', 'ts', 'python', 'go', 'rust', 'bash') },
  // ── image / media (numeric→string width family) ──────────────────────────
  'image.src': { noDefault: true, arb: urlArb, degen: '' },
  'image.align': { arb: str('left', 'right') },
  'image.alt': { arb: letterPhraseArb, degen: '' },
  'image.title': { arb: letterPhraseArb },
  'image.width': { arb: widthStr, degen: '' },
  'image.height': { arb: widthStr, degen: '' },
  'video.src': { noDefault: true, arb: urlArb, degen: '' },
  'video.alt': { arb: letterPhraseArb },
  'video.width': { arb: widthStr },
  'video.height': { arb: widthStr },
  'audio.src': { noDefault: true, arb: urlArb, degen: '' },
  'youtube.src': { noDefault: true, arb: urlArb },
  'pdf.src': { noDefault: true, arb: urlArb },
  'pdf.name': { arb: phraseArb },
  'drawio.src': { noDefault: true, arb: urlArb },
  'excalidraw.src': { noDefault: true, arb: urlArb },
  'attachment.url': { noDefault: true, arb: urlArb },
  'attachment.name': { arb: phraseArb },
  // ── callout / status ─────────────────────────────────────────────────────
  'callout.type': { always: true, arb: str('success', 'warning', 'danger') },
  'callout.icon': { frozen: true }, // ACCEPTED: no md representation (dropped on export)
  'status.text': { noDefault: true, arb: phraseArb, degen: '' },
  'status.color': { always: true, arb: str('green', 'orange', 'red', 'blue', 'yellow', 'purple') },
  // ── table cells — ACCEPTED: GFM tables cannot express spans / bg / colwidth ─
  'tableCell.colspan': { always: true, frozen: true },
  'tableCell.rowspan': { always: true, frozen: true },
  'tableCell.colwidth': { frozen: true },
  'tableCell.backgroundColor': { frozen: true },
  'tableCell.backgroundColorName': { frozen: true },
  'tableCell.align': { arb: str('left', 'center', 'right') },
  'tableHeader.colspan': { always: true, frozen: true },
  'tableHeader.rowspan': { always: true, frozen: true },
  'tableHeader.colwidth': { frozen: true },
  'tableHeader.backgroundColor': { frozen: true },
  'tableHeader.backgroundColorName': { frozen: true },
  'tableHeader.align': { arb: str('left', 'center', 'right') },
  // ── details ──────────────────────────────────────────────────────────────
  'details.open': { always: true, arb: fc.constant(true) }, // boolean, default false
  // ── columns ──────────────────────────────────────────────────────────────
  'columns.layout': { always: true, arb: str('three_equal', 'left_sidebar', 'right_sidebar') },
  // widthMode round-trips via the `data-width-mode` attribute (verified P1+P2),
  // so it is fuzzed, not frozen.
  'columns.widthMode': { always: true, arb: str('custom') },
  // PINNED-BUG: parseFloat import drops the `%` unit -> P2 churn. See
  // counterexamples.test.ts (columns-column-width-percent.json).
  'column.width': { frozen: true },
  // ── embed (schema keeps width/height NUMERIC, not string-coerced) ─────────
  'embed.src': { noDefault: true, arb: urlArb, degen: '' },
  'embed.provider': { noDefault: true, arb: str('iframe', 'youtube', 'vimeo') },
  'embed.width': { always: true, frozen: true },
  'embed.height': { always: true, frozen: true },
  // ── subpages / math / htmlEmbed ──────────────────────────────────────────
  'subpages.recursive': { always: true, arb: fc.constant(true) }, // boolean, default false
  'mathBlock.text': { noDefault: true, arb: str('x^2', 'a < b', '\\frac{1}{2}'), degen: '' },
  'mathInline.text': { noDefault: true, arb: str('x^2', 'a < b', '\\frac{1}{2}'), degen: '' },
  'htmlEmbed.source': { noDefault: true, arb: str('<b>hi</b>', '<i>x</i>', '<span>y</span>'), degen: '' },
  'htmlEmbed.height': { arb: num(200, 300, 400) },
  // ── footnotes / transclusion / pageEmbed / mention ───────────────────────
  'footnoteDefinition.id': { noDefault: true, arb: str('fn1', 'fn2', 'note') },
  'footnoteReference.id': { noDefault: true, arb: str('fn1', 'fn2', 'note') },
  'pageEmbed.sourcePageId': { noDefault: true, arb: fc.uuid() },
  'transclusionSource.id': { noDefault: true, arb: str('src1', 'src2') },
  'transclusionReference.sourcePageId': { noDefault: true, arb: fc.uuid() },
  'transclusionReference.transclusionId': { noDefault: true, arb: str('tr1', 'tr2') },
  'mention.id': { noDefault: true, arb: fc.uuid() },
  'mention.label': { noDefault: true, arb: phraseArb },
  'mention.entityType': { noDefault: true, arb: str('user') },
  'mention.entityId': { noDefault: true, arb: fc.uuid() },
};

/** Resolve the effective policy for one attribute (override merged over generic). */
function policyFor(type: string, attr: string, def: unknown): AttrPolicy {
  const override = OVERRIDES[`${type}.${attr}`];
  if (override) return override;
  // Generic: booleans are fuzzable via their flipped value; everything else is
  // frozen (only absent/default) so no unverified non-default is invented.
  if (typeof def === 'boolean') return { arb: fc.constant(!def) };
  return { frozen: true };
}

/**
 * Whether an attribute is actually exercised at a NON-DEFAULT value (i.e. its
 * policy has an `arb`, which the generic fallback does not). Used by the
 * attribute-coverage snapshot test to make the generic-frozen space VISIBLE: any
 * string/number attr not in OVERRIDES is silently only tested at absent/default,
 * so the snapshot pins exactly which attrs are NOT value-fuzzed and forces a
 * reviewer to look when a new attr lands in that invisible bucket.
 */
export function attrIsValueFuzzed(type: string, attr: string): boolean {
  const def = schemaAttrDefaults(type)[attr];
  return !!policyFor(type, attr, def).arb;
}

/** Every `type.attr` in the schema (excluding the auto `id`), sorted. */
export function allSchemaAttrKeys(): string[] {
  const keys: string[] = [];
  for (const type of Object.keys(schema.nodes)) {
    for (const attr of schemaAttrNames(type)) {
      if (attr === 'id') continue;
      keys.push(`${type}.${attr}`);
    }
  }
  return keys.sort();
}

export type AttrMode = 'p1' | 'fuzz';

/**
 * Build an arbitrary for ONE attribute's value (or the ABSENT sentinel) across
 * the states legal for `mode`:
 *   - p1   : absent / default / nonDefault (the round-trip-safe space).
 *   - fuzz : the above PLUS degenerate (P2 tolerates the one-time
 *            normalization; P3 only needs totality).
 */
export function attrValueArb(
  type: string,
  attr: string,
  mode: AttrMode,
): fc.Arbitrary<unknown | typeof ABSENT> {
  const def = schemaAttrDefaults(type)[attr];
  const p = policyFor(type, attr, def);

  const states: fc.Arbitrary<unknown | typeof ABSENT>[] = [];
  if (!p.always && !p.noDefault) states.push(fc.constant(ABSENT));
  if (!p.noDefault) states.push(fc.constant(def));
  if (!p.frozen && p.arb) states.push(p.arb);
  if (mode === 'fuzz' && !p.frozen && p.degen !== undefined) {
    states.push(fc.constant(p.degen));
  }
  if (states.length === 0) states.push(fc.constant(def));
  return fc.oneof(...states);
}

/**
 * Build an arbitrary for a node's full `attrs` object over all schema attrs.
 * `base` pins caller-required attrs (e.g. a concrete `src`) verbatim; any attr
 * present in `base` is NOT re-generated. Omitted (ABSENT) attrs are dropped.
 */
export function nodeAttrsArb(
  type: string,
  mode: AttrMode,
  base: Record<string, unknown> = {},
): fc.Arbitrary<Record<string, unknown>> {
  const names = schemaAttrNames(type).filter((n) => !(n in base) && n !== 'id');
  if (names.length === 0) return fc.constant({ ...base });
  return fc
    .tuple(...names.map((n) => attrValueArb(type, n, mode)))
    .map((vals) => {
      const attrs: Record<string, unknown> = { ...base };
      names.forEach((n, i) => {
        if (vals[i] !== ABSENT) attrs[n] = vals[i];
      });
      return attrs;
    });
}
