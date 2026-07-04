import {
  CORE_TOOL_KEYS,
  CORE_TOOL_SET,
  LOAD_TOOLS_NAME,
  LOAD_TOOLS_DESCRIPTION,
  INLINE_TOOL_TIERS,
  buildInAppDeferredCatalog,
  buildExternalToolCatalog,
  shortenForCatalog,
  applyLoadTools,
} from './tool-tiers';
// The real shared registry, imported from source (same approach as the
// SHARED_TOOL_SPECS contract spec) so the tier metadata is checked against
// exactly what @docmost/mcp ships.
import { SHARED_TOOL_SPECS } from '../../../../../../packages/mcp/src/tool-specs';

/**
 * #332 deferred tool loading — tier metadata, catalog assembly, and the
 * loadTools meta-tool. Pure units; no Nest graph, no @docmost/mcp build (the
 * registry is imported from TS source).
 */

describe('tool tier metadata (#332)', () => {
  it('core set is the documented 13 + searchInPage (14)', () => {
    expect(CORE_TOOL_KEYS).toHaveLength(14);
    expect(CORE_TOOL_SET.has('searchInPage')).toBe(true); // #330, promoted to core
    // loadTools is a meta-tool, not a normal core key.
    expect(CORE_TOOL_SET.has(LOAD_TOOLS_NAME)).toBe(false);
  });

  it('SHARED_TOOL_SPECS tier agrees with CORE_TOOL_SET for every shared tool', () => {
    for (const [key, spec] of Object.entries(SHARED_TOOL_SPECS)) {
      const isCoreByTier = spec.tier === 'core';
      const isCoreByList = CORE_TOOL_SET.has(key);
      expect(isCoreByTier).toBe(isCoreByList);
      // Every spec carries a non-empty catalogLine (core tools too).
      expect(typeof spec.catalogLine).toBe('string');
      expect(spec.catalogLine.trim().length).toBeGreaterThan(0);
    }
  });

  it('every INLINE tool tier agrees with CORE_TOOL_SET and has a catalogLine', () => {
    for (const [key, meta] of Object.entries(INLINE_TOOL_TIERS)) {
      expect(meta.tier === 'core').toBe(CORE_TOOL_SET.has(key));
      expect(meta.catalogLine.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('buildInAppDeferredCatalog (#332)', () => {
  const catalog = buildInAppDeferredCatalog(SHARED_TOOL_SPECS as never);
  const names = catalog.map((e) => e.name);

  it('includes deferred tools from BOTH the inline map and the shared registry', () => {
    expect(names).toContain('transformPage'); // inline deferred
    expect(names).toContain('getPageJson'); // shared deferred
    expect(names).toContain('patchNode'); // shared deferred
    expect(names).toContain('createPage'); // inline deferred
  });

  it('NEVER lists a core tool', () => {
    for (const core of CORE_TOOL_KEYS) {
      expect(names).not.toContain(core);
    }
    // spot-check a couple that are core in each source.
    expect(names).not.toContain('searchInPage'); // shared core
    expect(names).not.toContain('searchPages'); // inline core
    expect(names).not.toContain('editPageText'); // shared core
  });

  it('lists all 28 deferred tools (16 inline + 12 shared)', () => {
    expect(catalog).toHaveLength(28);
    // Each entry is a "name — purpose" line.
    for (const entry of catalog) {
      expect(entry.catalogLine).toMatch(/ — /);
    }
  });
});

describe('buildExternalToolCatalog + shortenForCatalog (#332)', () => {
  it('derives a short "name — purpose" line from each external tool description', () => {
    const catalog = buildExternalToolCatalog({
      tavily_search: { description: 'Search the web for fresh results. More detail here.' },
      tavily_extract: { description: '' },
    });
    expect(catalog).toEqual([
      { name: 'tavily_search', catalogLine: 'tavily_search — Search the web for fresh results.' },
      { name: 'tavily_extract', catalogLine: 'tavily_extract — external tool' },
    ]);
  });

  it('caps a very long description', () => {
    const long = 'x'.repeat(500);
    expect(shortenForCatalog(long).length).toBeLessThanOrEqual(140);
    expect(shortenForCatalog(long).endsWith('…')).toBe(true);
  });
});

describe('applyLoadTools (#332)', () => {
  const valid = new Set(['createPage', 'transformPage', 'tavily_search']);

  it('adds valid names to the activated set and returns { loaded }', () => {
    const activated = new Set<string>();
    const result = applyLoadTools(['createPage', 'tavily_search'], activated, valid);
    expect(result).toEqual({ loaded: ['createPage', 'tavily_search'] });
    expect(activated.has('createPage')).toBe(true);
    expect(activated.has('tavily_search')).toBe(true);
  });

  it('rejects an unknown name with an error listing the valid deferred names', () => {
    const activated = new Set<string>();
    expect(() => applyLoadTools(['nope'], activated, valid)).toThrow(/unknown tool name/i);
    try {
      applyLoadTools(['nope'], activated, valid);
    } catch (e) {
      const msg = (e as Error).message;
      // Lists every valid name (sorted).
      expect(msg).toContain('createPage');
      expect(msg).toContain('transformPage');
      expect(msg).toContain('tavily_search');
    }
    // Nothing is activated on a rejected call.
    expect(activated.size).toBe(0);
  });

  it('tolerates a non-array / empty input (loads nothing)', () => {
    const activated = new Set<string>();
    expect(applyLoadTools(undefined, activated, valid)).toEqual({ loaded: [] });
    expect(applyLoadTools([], activated, valid)).toEqual({ loaded: [] });
    expect(activated.size).toBe(0);
  });

  it('loadTools description is the verbatim issue text', () => {
    expect(LOAD_TOOLS_DESCRIPTION).toContain('only ACTIVATES them');
    expect(LOAD_TOOLS_DESCRIPTION).toContain('callable on your NEXT step');
  });
});

describe('editorial "Corrector" scenario is fully served by CORE (#332)', () => {
  it('read + comment + edit + search need no loadTools', () => {
    // A Corrector role reads a page, searches within it, edits text, and leaves
    // inline comments — every tool it needs is core, so it never has to load a
    // deferred tool.
    const needed = [
      'getCurrentPage',
      'getPage',
      'searchPages',
      'searchInPage',
      'editPageText',
      'createComment',
      'listComments',
      'getComment',
      'resolveComment',
    ];
    for (const t of needed) {
      expect(CORE_TOOL_SET.has(t)).toBe(true);
    }
  });
});
