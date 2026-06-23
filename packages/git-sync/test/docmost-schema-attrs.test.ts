import { describe, expect, it } from 'vitest';
import {
  sanitizeCssColor,
  clampCalloutType,
} from '../src/lib/docmost-schema.js';

// These tests pin the two security/normalization helpers that Docmost
// interpolates into inline style and the callout banner type on re-render.
// They are the allowlist guard (XSS/style-breakout boundary) and the
// case-insensitive callout normalizer, both otherwise only exercised
// indirectly through parseHTML/renderHTML.

describe('sanitizeCssColor', () => {
  it('accepts a plain named color unchanged', () => {
    expect(sanitizeCssColor('red')).toBe('red');
  });

  it('accepts 3-digit and 6-digit hex colors unchanged', () => {
    expect(sanitizeCssColor('#abc')).toBe('#abc');
    expect(sanitizeCssColor('#aabbcc')).toBe('#aabbcc');
  });

  it('accepts well-formed functional notation unchanged', () => {
    expect(sanitizeCssColor('rgb(1,2,3)')).toBe('rgb(1,2,3)');
    expect(sanitizeCssColor('rgba(0,0,0,0.5)')).toBe('rgba(0,0,0,0.5)');
    expect(sanitizeCssColor('hsl(120,50%,50%)')).toBe('hsl(120,50%,50%)');
  });

  it('trims surrounding whitespace before matching', () => {
    // '  blue  ' trims to 'blue', which is a valid named color.
    expect(sanitizeCssColor('  blue  ')).toBe('blue');
  });

  it('rejects a style-injection payload (returns null)', () => {
    expect(sanitizeCssColor('red; --x: url(x)')).toBeNull();
  });

  it('rejects an attribute-breakout payload (returns null)', () => {
    expect(sanitizeCssColor('red"><script>')).toBeNull();
  });

  it('rejects the empty string (returns null)', () => {
    expect(sanitizeCssColor('')).toBeNull();
  });

  it('rejects non-string input via the typeof guard (returns null)', () => {
    // @ts-expect-error deliberately passing a non-string to exercise the guard
    expect(sanitizeCssColor(123)).toBeNull();
  });
});

describe('clampCalloutType', () => {
  it('lowercases an uppercase valid type', () => {
    expect(clampCalloutType('INFO')).toBe('info');
  });

  it('lowercases a mixed-case valid type', () => {
    expect(clampCalloutType('Warning')).toBe('warning');
  });

  it('passes through already-lowercase valid types', () => {
    expect(clampCalloutType('danger')).toBe('danger');
    expect(clampCalloutType('success')).toBe('success');
  });

  it('falls back to "info" for unknown types', () => {
    expect(clampCalloutType('note')).toBe('info');
    expect(clampCalloutType('tip')).toBe('info');
  });

  it('falls back to "info" for empty string and null', () => {
    expect(clampCalloutType('')).toBe('info');
    expect(clampCalloutType(null)).toBe('info');
  });
});
