import { describe, expect, it, vi } from 'vitest';

import { createServer } from '../src/server.js';
import { buildToolFilter, ToolFilterError } from '../src/tool-filter.js';
import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../src/tools/catalogue.js';
import { testConfig, toolNames } from './harness.js';

describe('the catalogue matches the server that is actually built', () => {
  // The catalogue is hand-written so the filter can answer questions about
  // tools that read-only mode never registers. This is the test that keeps that
  // list honest — and the reason no other test file repeats the names.
  it('registers exactly ALL_TOOLS by default', async () => {
    const names = await toolNames(testConfig());
    expect([...names].sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('registers exactly READ_TOOLS under WIKIJS_READ_ONLY', async () => {
    const names = await toolNames(testConfig({ readOnly: true }));
    expect([...names].sort()).toEqual([...READ_TOOLS].sort());
  });

  it('has no name in both halves', () => {
    const overlap = READ_TOOLS.filter((t) =>
      (WRITE_TOOLS as readonly string[]).includes(t)
    );
    expect(overlap).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it('uses lowercase snake_case throughout, which the filter relies on', () => {
    for (const name of ALL_TOOLS) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

describe('ESSENTIAL_TOOLS', () => {
  it('names only tools that exist', () => {
    for (const name of ESSENTIAL_TOOLS) expect(ALL_TOOLS).toContain(name);
  });

  it('stays a handful — five to eight', () => {
    expect(ESSENTIAL_TOOLS.length).toBeGreaterThanOrEqual(5);
    expect(ESSENTIAL_TOOLS.length).toBeLessThanOrEqual(8);
  });

  it('contains nothing irreversible or administrative', () => {
    for (const name of ESSENTIAL_TOOLS) {
      expect(name).not.toMatch(/^(delete_|purge_|revoke_|move_|migrate_)/);
      expect(name).not.toMatch(/_(user|group|api_key)s?$/);
    }
  });

  it('can find, read and write a page end to end', () => {
    expect(ESSENTIAL_TOOLS).toContain('get_page');
    expect(ESSENTIAL_TOOLS).toContain('create_page');
    expect(ESSENTIAL_TOOLS).toContain('update_page');
    // grep_pages, because on a default Wiki.js the search engine cannot find
    // anything written *inside* a page.
    expect(ESSENTIAL_TOOLS).toContain('grep_pages');
  });
});

describe('buildToolFilter', () => {
  const base = { allowTools: undefined, denyTools: undefined, readOnly: false };

  it('is inactive when neither variable is set', () => {
    expect(buildToolFilter(base).active).toBe(false);
  });

  it('treats an empty value as unset, not as "allow nothing"', () => {
    expect(buildToolFilter({ ...base, allowTools: '' }).active).toBe(false);
    expect(buildToolFilter({ ...base, allowTools: '  , ' }).active).toBe(false);
  });

  it('selects exact names, ignoring case and stray whitespace', () => {
    const filter = buildToolFilter({
      ...base,
      allowTools: ' GET_PAGE , list_pages ',
    });
    expect([...filter.selected].sort()).toEqual(['get_page', 'list_pages']);
  });

  it('expands a trailing-star prefix', () => {
    const filter = buildToolFilter({ ...base, allowTools: 'list_*' });
    expect([...filter.selected].every((t) => t.startsWith('list_'))).toBe(true);
    expect(filter.selected.size).toBeGreaterThan(5);
  });

  it('expands the essential preset', () => {
    const filter = buildToolFilter({ ...base, allowTools: 'essential' });
    expect([...filter.selected].sort()).toEqual([...ESSENTIAL_TOOLS].sort());
  });

  it('subtracts the deny list from the allow list', () => {
    const filter = buildToolFilter({
      ...base,
      allowTools: 'essential',
      denyTools: 'create_page,update_page',
    });
    expect(filter.selected.has('create_page')).toBe(false);
    expect(filter.selected.has('get_page')).toBe(true);
  });

  it('aborts on a name that matches nothing — an absent tool is invisible', () => {
    expect(() => buildToolFilter({ ...base, allowTools: 'get_pge' })).toThrow(
      ToolFilterError
    );
    expect(() => buildToolFilter({ ...base, denyTools: 'nope' })).toThrow(
      ToolFilterError
    );
  });

  it('aborts on a malformed pattern rather than matching nothing forever', () => {
    expect(() => buildToolFilter({ ...base, allowTools: '*_page' })).toThrow(
      /trailing "\*"/
    );
    expect(() => buildToolFilter({ ...base, allowTools: 'list_*_x' })).toThrow(
      ToolFilterError
    );
  });

  it('says a named write tool is suppressed by read-only, not unknown', () => {
    expect(() =>
      buildToolFilter({ ...base, allowTools: 'delete_page', readOnly: true })
    ).toThrow(/is a write tool, but WIKIJS_READ_ONLY/);
  });

  it('only warns when a pattern happens to match write tools under read-only', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      buildToolFilter({
        ...base,
        allowTools: 'delete_*,get_page',
        readOnly: true,
      })
    ).not.toThrow();
    expect(error.mock.calls.flat().join(' ')).toContain('contributes nothing');
    error.mockRestore();
  });

  it('drops preset members suppressed by read-only silently', () => {
    // Nobody typed those names, so they are not a typo to report.
    const filter = buildToolFilter({
      ...base,
      allowTools: 'essential',
      readOnly: true,
    });
    expect(filter.selected.has('create_page')).toBe(false);
    expect(filter.selected.has('get_page')).toBe(true);
  });

  it('aborts rather than starting with an empty tool list', () => {
    expect(() =>
      buildToolFilter({
        ...base,
        allowTools: 'get_page',
        denyTools: 'get_page',
      })
    ).toThrow(/no tools registered/);
    expect(() =>
      buildToolFilter({ ...base, allowTools: 'delete_*', readOnly: true })
    ).toThrow(/only write tools/);
  });

  it('throws rather than exiting, so createServer stays testable', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('should not exit');
    }) as never);
    expect(() => createServer(testConfig({ allowTools: 'nope' }))).toThrow(
      ToolFilterError
    );
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});

describe('the filter applied to a real server', () => {
  it('registers only the selected tools', async () => {
    const names = await toolNames(testConfig({ allowTools: 'essential' }));
    expect([...names].sort()).toEqual([...ESSENTIAL_TOOLS].sort());
  });

  it('still answers tools/list when almost everything is filtered out', async () => {
    // The SDK installs its tools/list handler from inside the registration
    // path, so tools have to be registered and then removed, never skipped.
    const names = await toolNames(testConfig({ allowTools: 'get_page' }));
    expect(names).toEqual(['get_page']);
  });

  it('answers a filtered tool exactly as read-only answers a suppressed one', async () => {
    // This is what `remove()` buys over `disable()`: a tool the operator turned
    // off is indistinguishable from one that was never there, rather than
    // advertising a refusal.
    const { connect } = await import('./harness.js');
    const filtered = await connect(testConfig({ allowTools: 'get_page' }));
    const readOnly = await connect(testConfig({ readOnly: true }));
    // SDK v2 answers a call to an unknown tool with a JSON-RPC error rather
    // than a result carrying isError, so both calls reject. The equivalence is
    // what this test is about and is unaffected.
    const refusal = (harness: {
      call: (name: string, args: object) => Promise<unknown>;
    }) =>
      harness.call('delete_page', { page_id: 1 }).then(
        () => {
          throw new Error('delete_page answered instead of being refused');
        },
        (error: Error) => error.message
      );
    const a = await refusal(filtered);
    const b = await refusal(readOnly);
    expect(a).toEqual(b);
    expect(a).toMatch(/not found/i);
    await filtered.close();
    await readOnly.close();
  });
});
