import { describe, expect, it } from 'vitest';

import {
  confirmTokenParam,
  contentParam,
  editorParam,
  emailParam,
  httpUrlParam,
  idParam,
  limitParam,
  localeParam,
  pagePathParam,
  patternParam,
  tagParam,
} from '../src/schema.js';

describe('pagePathParam', () => {
  it('accepts an ordinary path', () => {
    expect(pagePathParam.parse(' docs/setup ')).toBe('docs/setup');
  });

  it('rejects leading and trailing slashes, which people copy from a URL', () => {
    expect(() => pagePathParam.parse('/docs/setup')).toThrow(
      /leading or trailing slash/
    );
    expect(() => pagePathParam.parse('docs/setup/')).toThrow(
      /leading or trailing slash/
    );
  });

  it('rejects traversal and control characters', () => {
    expect(() => pagePathParam.parse('docs/../etc')).toThrow(/\.\./);
    expect(() => pagePathParam.parse('docs/\u0001x')).toThrow(
      /control characters/
    );
  });

  it('allows two-letter first segments that are not locales', () => {
    // ci/, db/ and qa/ are perfectly good page trees, and rejecting them
    // because they look like locale codes would block real wikis.
    for (const path of ['ci/pipelines', 'db/schema', 'qa/checklist']) {
      expect(pagePathParam.parse(path)).toBe(path);
    }
  });
});

describe('localeParam', () => {
  it('lowercases and accepts region codes', () => {
    expect(localeParam.parse('EN')).toBe('en');
    expect(localeParam.parse('pt-br')).toBe('pt-br');
  });

  it('rejects anything that is not a locale code', () => {
    expect(() => localeParam.parse('english')).toThrow();
    expect(() => localeParam.parse('e')).toThrow();
  });
});

describe('tagParam', () => {
  it('lowercases a tag', () => {
    expect(tagParam.parse(' Docs ')).toBe('docs');
  });

  it('rejects spaces and commas, which Wiki.js would split into several tags', () => {
    expect(() => tagParam.parse('two words')).toThrow(/several tags/);
    expect(() => tagParam.parse('a,b')).toThrow(/several tags/);
  });
});

describe('httpUrlParam', () => {
  it('rejects the schemes z.string().url() would accept', () => {
    // zod's url() takes javascript:, file: and data:. A scheme check that lives
    // in the schema is the only one that cannot be forgotten at a call site.
    for (const bad of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      'ftp://example.net',
      'not a url',
    ]) {
      expect(() => httpUrlParam.parse(bad)).toThrow(/http:\/\/ or https:\/\//);
    }
  });

  it('accepts http and https', () => {
    expect(httpUrlParam.parse('https://example.net/a')).toBe(
      'https://example.net/a'
    );
    expect(httpUrlParam.parse('http://localhost:3000')).toBe(
      'http://localhost:3000'
    );
  });
});

describe('the remaining shared parameters', () => {
  it('bounds ids to something an id can actually be', () => {
    expect(() => idParam.parse(0)).toThrow();
    expect(() => idParam.parse(1.5)).toThrow();
    expect(idParam.parse(1)).toBe(1);
  });

  it('bounds the limit', () => {
    expect(() => limitParam.parse(0)).toThrow();
    expect(() => limitParam.parse(501)).toThrow();
  });

  it('requires a 32-character hex confirmation token', () => {
    expect(() => confirmTokenParam.parse('short')).toThrow(/32 hexadecimal/);
    expect(confirmTokenParam.parse('a'.repeat(32))).toBe('a'.repeat(32));
  });

  it('refuses empty page content, which Wiki.js rejects anyway', () => {
    expect(() => contentParam.parse('')).toThrow(/empty content/);
  });

  it('only knows the four editors Wiki.js has', () => {
    expect(editorParam.parse('markdown')).toBe('markdown');
    expect(() => editorParam.parse('rst')).toThrow();
  });

  it('checks an email loosely but usefully', () => {
    expect(emailParam.parse(' A@B.CO ')).toBe('a@b.co');
    expect(() => emailParam.parse('not-an-email')).toThrow();
  });

  it('rejects a pattern that will not compile, before fetching any page', () => {
    expect(() => patternParam.parse('([')).toThrow(/regular expression/);
    expect(patternParam.parse('a+b')).toBe('a+b');
  });
});
