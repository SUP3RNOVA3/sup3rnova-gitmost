import { describe, expect, it } from 'vitest';
import { sanitizeTitle, disambiguate } from '../src/engine/sanitize.js';

describe('sanitizeTitle', () => {
  it('passes a plain title through unchanged', () => {
    expect(sanitizeTitle('Getting Started')).toBe('Getting Started');
  });

  it('replaces every forbidden printable character with a dash', () => {
    // Forbidden set: / \ < > : " | ? *
    expect(sanitizeTitle('a/b\\c<d>e:f"g|h?i*j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });

  it('replaces ASCII control characters with a dash', () => {
    // Build the input with explicit control code points (tab=9, newline=10) to
    // avoid editor escaping pitfalls. Control chars become "-" BEFORE
    // whitespace is collapsed, so they survive as dashes (not a folded space).
    const TAB = String.fromCharCode(9);
    const NL = String.fromCharCode(10);
    expect(sanitizeTitle('a b' + TAB + 'c' + NL + 'd')).toBe('a b-c-d');
  });

  it('collapses runs of plain whitespace to a single space and trims', () => {
    expect(sanitizeTitle('  hello   world  ')).toBe('hello world');
  });

  it('caps the length at 120 characters', () => {
    const long = 'x'.repeat(200);
    const out = sanitizeTitle(long);
    expect(out.length).toBe(120);
    expect(out).toBe('x'.repeat(120));
  });

  it('prefixes reserved Windows names with an underscore', () => {
    expect(sanitizeTitle('CON')).toBe('_CON');
    expect(sanitizeTitle('nul')).toBe('_nul');
    // The base name (before the first dot) is what matters.
    expect(sanitizeTitle('con.md')).toBe('_con.md');
  });

  it('does not flag names that merely contain a reserved word', () => {
    expect(sanitizeTitle('console')).toBe('console');
    expect(sanitizeTitle('Control')).toBe('Control');
  });

  it('returns "_" for empty or whitespace-only input', () => {
    expect(sanitizeTitle('')).toBe('_');
    expect(sanitizeTitle('   ')).toBe('_');
  });

  it('handles a title that is only forbidden characters', () => {
    // Each forbidden char becomes "-", so the result is non-empty and safe.
    expect(sanitizeTitle('///')).toBe('---');
  });

  it('neutralizes all-dot names so they cannot escape the vault', () => {
    // ".", "..", "..." (and whitespace-padded variants) are path-traversal
    // hazards as directory segments. The result must never be a pure-dot
    // segment and must contain no path separators.
    for (const input of ['.', '..', '...', ' .. ']) {
      const out = sanitizeTitle(input);
      expect(['.', '..', '...']).not.toContain(out);
      expect(/^\.+$/.test(out)).toBe(false);
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
    }
    // The concrete prefixing behaviour (existing "_" safeguard).
    expect(sanitizeTitle('.')).toBe('_.');
    expect(sanitizeTitle('..')).toBe('_..');
    expect(sanitizeTitle('...')).toBe('_...');
    expect(sanitizeTitle(' .. ')).toBe('_..');
  });

  it('is deterministic — the same input yields the same output', () => {
    const title = 'Some / weird : title?';
    expect(sanitizeTitle(title)).toBe(sanitizeTitle(title));
  });
});

describe('disambiguate', () => {
  it('appends a stable ~slugId suffix', () => {
    expect(disambiguate('Notes', 'abc123')).toBe('Notes ~abc123');
  });

  it('is deterministic for the same name and slugId', () => {
    expect(disambiguate('Notes', 'abc123')).toBe(
      disambiguate('Notes', 'abc123'),
    );
  });

  it('produces distinct names for colliding siblings', () => {
    const a = disambiguate('Notes', 'slug-a');
    const b = disambiguate('Notes', 'slug-b');
    expect(a).not.toBe(b);
  });
});
