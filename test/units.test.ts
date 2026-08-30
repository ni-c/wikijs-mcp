import { describe, expect, it } from 'vitest';

import { unifiedDiff } from '../src/diff.js';
import { applyEdits, EditError } from '../src/edits.js';
import { outlineOf, sectionOf, windowOf } from '../src/markdown.js';
import {
  redactSensitive,
  listOf,
  objectOf,
  pick,
  REDACTED,
} from '../src/normalize.js';
import {
  assertWithinScope,
  buildPathScope,
  isWithinScope,
  PathScopeError,
} from '../src/paths.js';
import { PageReadLog } from '../src/read-log.js';

describe('applyEdits', () => {
  it('applies a unique edit', () => {
    expect(
      applyEdits('alpha beta', [{ old_text: 'beta', new_text: 'gamma' }])
    ).toBe('alpha gamma');
  });

  it('refuses an ambiguous match instead of taking the first', () => {
    // The failure mode every other Wiki.js MCP server has: `replace(old, new, 1)`
    // silently edits whichever occurrence comes first.
    expect(() =>
      applyEdits('one one', [{ old_text: 'one', new_text: 'two' }])
    ).toThrow(/appears 2 times/);
  });

  it('refuses a match that is not there', () => {
    expect(() =>
      applyEdits('alpha', [{ old_text: 'beta', new_text: 'x' }])
    ).toThrow(/does not appear/);
  });

  it('applies edits in order, against the running result', () => {
    expect(
      applyEdits('a b c', [
        { old_text: 'a', new_text: 'x' },
        { old_text: 'x b', new_text: 'y' },
      ])
    ).toBe('y c');
  });

  it('names which edit failed after earlier ones changed the text', () => {
    expect(() =>
      applyEdits('a b', [
        { old_text: 'a', new_text: 'z' },
        { old_text: 'a', new_text: 'q' },
      ])
    ).toThrow(/edit 2 of 2.*after the preceding edits/s);
  });

  it('rejects an empty edit list, an empty anchor and a no-op', () => {
    expect(() => applyEdits('x', [])).toThrow(EditError);
    expect(() => applyEdits('x', [{ old_text: '', new_text: 'y' }])).toThrow(
      /old_text is empty/
    );
    expect(() => applyEdits('x', [{ old_text: 'x', new_text: 'x' }])).toThrow(
      /identical/
    );
  });

  it('treats the replacement literally, so $& in new_text is not a backreference', () => {
    expect(applyEdits('a', [{ old_text: 'a', new_text: '$&$1' }])).toBe('$&$1');
  });
});

describe('outlineOf', () => {
  it('finds ATX headings with their levels and lines', () => {
    expect(outlineOf('# One\n\ntext\n\n## Two\n')).toEqual([
      { level: 1, title: 'One', line: 1, offset: 0 },
      { level: 2, title: 'Two', line: 5, offset: 13 },
    ]);
  });

  it('ignores hashes inside a fenced code block', () => {
    // A shell session in a fence is full of lines starting with #, and every one
    // of them would otherwise become a section the page does not have.
    const outline = outlineOf(
      '# Real\n\n```sh\n# not a heading\n```\n\n## Also real\n'
    );
    expect(outline.map((h) => h.title)).toEqual(['Real', 'Also real']);
  });

  it('handles tilde fences and unclosed fences', () => {
    expect(
      outlineOf('~~~\n# hidden\n~~~\n# shown\n').map((h) => h.title)
    ).toEqual(['shown']);
    expect(outlineOf('```\n# hidden\n').map((h) => h.title)).toEqual([]);
  });

  it('finds setext headings but not list items', () => {
    expect(outlineOf('Title\n=====\n').map((h) => h.level)).toEqual([1]);
    expect(outlineOf('Sub\n---\n').map((h) => h.level)).toEqual([2]);
    expect(outlineOf('- item\n---\n')).toEqual([]);
  });

  it('strips closing hashes', () => {
    expect(outlineOf('## Title ##\n')[0]?.title).toBe('Title');
  });
});

describe('sectionOf', () => {
  const page =
    '# Top\n\nintro\n\n## A\n\nalpha\n\n### A1\n\nsub\n\n## B\n\nbeta\n';

  it('returns a section including its subsections', () => {
    const found = sectionOf(page, 'A');
    expect(found).toMatchObject({ heading: 'A', level: 2 });
    expect('text' in found && found.text).toContain('### A1');
    expect('text' in found && found.text).not.toContain('## B');
  });

  it('matches case- and punctuation-insensitively', () => {
    expect(sectionOf(page, 'a')).toMatchObject({ heading: 'A' });
  });

  it('refuses an ambiguous heading rather than guessing', () => {
    const twice = '# T\n\n## Install\n\none\n\n## Install\n\ntwo\n';
    const found = sectionOf(twice, 'Install');
    expect('error' in found && found.error).toMatch(/matches 2 headings/);
  });

  it('lists the real headings when nothing matches', () => {
    const found = sectionOf(page, 'Nope');
    expect('error' in found && found.error).toContain('## A');
  });

  it('explains itself on a page with no headings', () => {
    const found = sectionOf('just text\n', 'A');
    expect('error' in found && found.error).toMatch(/no markdown headings/);
  });
});

describe('windowOf', () => {
  it('returns the whole text when it fits, with no follow-up note', () => {
    const w = windowOf('abc', 0, 10);
    expect(w).toMatchObject({ text: 'abc', truncated: false, totalChars: 3 });
    expect(w.note).toBeUndefined();
  });

  it('names the next offset when there is more, so reading can continue', () => {
    const w = windowOf('abcdef', 0, 3);
    expect(w).toMatchObject({ text: 'abc', truncated: true, returnedChars: 3 });
    expect(w.note).toContain('offset=3');
  });

  it('clamps an offset past the end instead of throwing', () => {
    expect(windowOf('abc', 99, 10)).toMatchObject({ text: '', offset: 3 });
  });
});

describe('unifiedDiff', () => {
  it('reports identical inputs without producing a diff', () => {
    expect(unifiedDiff('a\nb', 'a\nb')).toMatchObject({
      identical: true,
      added: 0,
      removed: 0,
    });
  });

  it('produces hunks with context and counts the changes', () => {
    const result = unifiedDiff('a\nb\nc', 'a\nB\nc');
    expect(result.identical).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.diff).toContain('-b');
    expect(result.diff).toContain('+B');
    expect(result.diff).toMatch(/^@@ /m);
  });

  it('shows only the changed neighbourhood, not the whole document', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join(
      '\n'
    );
    const after = before.replace('line 100', 'line one hundred');
    const result = unifiedDiff(before, after, 2);
    expect(result.diff.split('\n').length).toBeLessThan(12);
    expect(result.diff).toContain('line one hundred');
  });

  it('handles pure insertions and pure deletions', () => {
    expect(unifiedDiff('', 'a').added).toBe(1);
    expect(unifiedDiff('a\nb', 'a').removed).toBe(1);
  });

  it('declines rather than hanging on an enormous pair', () => {
    const huge = Array.from({ length: 11_000 }, (_, i) => String(i)).join('\n');
    const result = unifiedDiff(huge, `${huge}\nx`);
    expect(result.diff).toBe('');
    expect(result.note).toMatch(/ceiling/);
  });
});

describe('buildPathScope', () => {
  it('is inactive when unset or empty', () => {
    expect(buildPathScope(undefined).active).toBe(false);
    // An empty value in a compose file must not mean "nothing is writable".
    expect(buildPathScope('').active).toBe(false);
    expect(buildPathScope('  ,  ').active).toBe(false);
  });

  it('normalises surrounding slashes', () => {
    expect(buildPathScope('/docs/, team/notes').prefixes).toEqual([
      'docs',
      'team/notes',
    ]);
  });

  it('rejects traversal and wildcards', () => {
    expect(() => buildPathScope('../etc')).toThrow(PathScopeError);
    expect(() => buildPathScope('docs/*')).toThrow(PathScopeError);
  });
});

describe('isWithinScope', () => {
  const scope = buildPathScope('docs,team/notes');

  it('matches the prefix itself and anything below it', () => {
    expect(isWithinScope(scope, 'docs')).toBe(true);
    expect(isWithinScope(scope, 'docs/setup/detail')).toBe(true);
    expect(isWithinScope(scope, 'team/notes/2026')).toBe(true);
  });

  it('does not let "docs" cover "docs-archive"', () => {
    // A bare startsWith would, and they are different page trees that merely
    // begin with the same letters.
    expect(isWithinScope(scope, 'docs-archive/old')).toBe(false);
    expect(isWithinScope(scope, 'documentation')).toBe(false);
    expect(isWithinScope(scope, 'team/notesx')).toBe(false);
  });

  it('allows everything when inactive', () => {
    expect(isWithinScope(buildPathScope(undefined), 'anything')).toBe(true);
  });

  it('names the allowed prefixes when it refuses', () => {
    expect(() => assertWithinScope(scope, 'other/page', 'page path')).toThrow(
      /confined to: docs, team\/notes/
    );
  });
});

describe('PageReadLog', () => {
  it('remembers and forgets a page', () => {
    const log = new PageReadLog();
    expect(log.checkoutDate(1)).toBeUndefined();
    log.record(1, 'T1');
    expect(log.checkoutDate(1)).toBe('T1');
    log.forget(1);
    expect(log.checkoutDate(1)).toBeUndefined();
  });

  it('evicts the least recently read entry once full', () => {
    const log = new PageReadLog();
    for (let i = 0; i < 500; i++) log.record(i, `T${i}`);
    log.record(0, 'refreshed');
    log.record(1000, 'new');
    expect(log.checkoutDate(0)).toBe('refreshed');
    expect(log.checkoutDate(1)).toBeUndefined();
  });
});

describe('redactSensitive', () => {
  it('replaces a secret rather than dropping it', () => {
    // A missing field reads as "there is none", which is a different claim.
    const out = redactSensitive({ name: 'x', dkimPrivateKey: 'k' }) as Record<
      string,
      unknown
    >;
    expect(out.dkimPrivateKey).toBe(REDACTED);
    expect(out.name).toBe('x');
  });

  it('finds secrets at any depth', () => {
    const out = redactSensitive({ a: { b: [{ password: 'p' }] } }) as {
      a: { b: Array<{ password: string }> };
    };
    expect(out.a.b[0]?.password).toBe(REDACTED);
  });

  it('redacts credential-shaped config entries in a key/value list', () => {
    // Storage targets return their settings as [{key, value}], so the telling
    // name is inside the object rather than on the property holding it.
    const out = redactSensitive([
      { key: 'secretAccessKey', value: 'shh' },
      { key: 'bucket', value: 'public-name' },
    ]) as Array<{ value: string }>;
    expect(out[0]?.value).toBe(REDACTED);
    expect(out[1]?.value).toBe('public-name');
  });

  it('hides the host filesystem and database host from system info', () => {
    const out = redactSensitive({
      dbHost: 'db.internal',
      configFile: '/etc/wiki/config.yml',
      workingDirectory: '/wiki',
      currentVersion: '2.5.314',
    }) as Record<string, unknown>;
    expect(out.dbHost).toBe(REDACTED);
    expect(out.configFile).toBe(REDACTED);
    expect(out.workingDirectory).toBe(REDACTED);
    expect(out.currentVersion).toBe('2.5.314');
  });
});

describe('listOf / objectOf / pick', () => {
  it('points at permissions when a list came back null', () => {
    expect(() => listOf(null, 'pages')).toThrow(/permission scope/);
    expect(() => listOf('nope', 'pages')).toThrow(/unexpected shape/);
    expect(listOf([1], 'pages')).toEqual([1]);
  });

  it('does the same for a single object', () => {
    expect(() => objectOf(undefined, 'page 1')).toThrow(/does not exist/);
    expect(() => objectOf([], 'page 1')).toThrow(/unexpected shape/);
    expect(objectOf({ a: 1 }, 'page 1')).toEqual({ a: 1 });
  });

  it('keeps only the named, defined properties', () => {
    expect(pick({ a: 1, b: undefined, c: 3 }, ['a', 'b'])).toEqual({ a: 1 });
  });
});
