import { parseSearchQuery, hasPositiveRecall } from './search-query-parser';

describe('parseSearchQuery — tokenization & operators (A2)', () => {
  it('splits on whitespace into positive terms (OR recall)', () => {
    const p = parseSearchQuery('стамбул роснефть');
    expect(p.positive.map((t) => t.text)).toEqual(['стамбул', 'роснефть']);
    expect(p.required).toEqual([]);
    expect(p.excluded).toEqual([]);
    expect(p.mode).toBe('or');
  });

  it('treats +term as required and -term as excluded', () => {
    const p = parseSearchQuery('+кофейня -архив');
    expect(p.required.map((t) => t.text)).toEqual(['кофейня']);
    expect(p.excluded.map((t) => t.text)).toEqual(['архив']);
    expect(p.positive).toEqual([]);
  });

  it('keeps a leading-operator-free hyphen/dot/colon token as ONE literal term', () => {
    // WB-MGE-30D86B, 10.0.12.5, a:b — internal -,.,: are literal, one term each.
    expect(parseSearchQuery('WB-MGE-30D86B').positive[0].text).toBe(
      'WB-MGE-30D86B',
    );
    expect(parseSearchQuery('10.0.12.5').positive[0].text).toBe('10.0.12.5');
    expect(parseSearchQuery('host:8080').positive[0].text).toBe('host:8080');
  });

  it('only a LEADING +/- is an operator; -архив excludes архив', () => {
    const p = parseSearchQuery('-архив');
    expect(p.excluded.map((t) => t.text)).toEqual(['архив']);
    expect(p.positive).toEqual([]);
  });

  it('drops a bare "-" / "+" and an all-operator remainder', () => {
    const p = parseSearchQuery('- + foo -- ++');
    expect(p.positive.map((t) => t.text)).toEqual(['foo']);
    expect(p.required).toEqual([]);
    expect(p.excluded).toEqual([]);
  });

  it('parses a quoted phrase as one adjacency term', () => {
    const p = parseSearchQuery('"воздушный шар" кофе');
    expect(p.positive[0]).toMatchObject({ text: 'воздушный шар', branch: 'phrase' });
    expect(p.positive[1].text).toBe('кофе');
  });

  it('applies +/- to a phrase', () => {
    const req = parseSearchQuery('+"воздушный шар"');
    expect(req.required[0]).toMatchObject({ text: 'воздушный шар', branch: 'phrase' });
    const exc = parseSearchQuery('-"воздушный шар"');
    expect(exc.excluded[0]).toMatchObject({ text: 'воздушный шар', branch: 'phrase' });
  });

  it('drops an unbalanced quote token', () => {
    const p = parseSearchQuery('kafka "unclosed here');
    expect(p.positive.map((t) => t.text)).toEqual(['kafka']);
  });

  it('strips tsquery metacharacters from a bare FTS term (no 500)', () => {
    const p = parseSearchQuery('foo|bar');
    // `|` is not an identifier signal → FTS branch; the metachar is stripped so
    // the term becomes the two words that survive.
    expect(p.positive[0].branch === 'fts' || p.positive[0].branch === 'ftsPrefix').toBe(true);
    expect(p.positive[0].text).toBe('foo bar');
  });
});

describe('parseSearchQuery — match=auto classification (A3)', () => {
  it('routes identifier-like terms to the substring branch', () => {
    expect(parseSearchQuery('10.31.41').positive[0].branch).toBe('substring');
    expect(parseSearchQuery('esp32').positive[0].branch).toBe('substring');
    expect(parseSearchQuery('WB-MGE-30D86B').positive[0].branch).toBe('substring');
  });

  it('routes purely-alphabetic words to the FTS (prefix) branch', () => {
    expect(parseSearchQuery('печат').positive[0].branch).toBe('ftsPrefix');
    expect(parseSearchQuery('ресторан').positive[0].branch).toBe('ftsPrefix');
  });

  it('explicit match overrides: word / prefix / substring', () => {
    expect(parseSearchQuery('печат', { match: 'word' }).positive[0].branch).toBe('fts');
    expect(parseSearchQuery('печат', { match: 'prefix' }).positive[0].branch).toBe(
      'ftsPrefix',
    );
    expect(parseSearchQuery('печат', { match: 'substring' }).positive[0].branch).toBe(
      'substring',
    );
  });
});

describe('parseSearchQuery — reasons & recall', () => {
  it('only-negation yields reason only-negation and no positive recall', () => {
    const p = parseSearchQuery('-архив');
    expect(p.reason).toBe('only-negation');
    expect(hasPositiveRecall(p)).toBe(false);
  });

  it('empty / whitespace / garbage yields reason empty', () => {
    expect(parseSearchQuery('').reason).toBe('empty');
    expect(parseSearchQuery('   ').reason).toBe('empty');
    // A bare operator drops to nothing → empty (no exclusion survived).
    expect(parseSearchQuery('+ -').reason).toBe('empty');
  });

  it('a required term alone IS positive recall (no reason)', () => {
    const p = parseSearchQuery('+кофейня');
    expect(p.reason).toBeUndefined();
    expect(hasPositiveRecall(p)).toBe(true);
  });

  it('mode flag flows through', () => {
    expect(parseSearchQuery('a b', { mode: 'and' }).mode).toBe('and');
    expect(parseSearchQuery('a b').mode).toBe('or');
  });
});
