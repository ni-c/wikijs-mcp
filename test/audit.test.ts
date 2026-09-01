import { afterEach, describe, expect, it, vi } from 'vitest';

import { unifiedDiff } from '../src/diff.js';
import {
  matchPages,
  MATCH_TIMEOUT_MS,
  PatternTimeoutError,
} from '../src/grep.js';
import { redactSensitive, REDACTED } from '../src/normalize.js';
import { budgetedList, MAX_RESULT_BYTES } from '../src/result.js';
import { setResourceKey } from 'mcp-approval';

import { identifier } from '../src/resource-key.js';
import {
  connect,
  stubFetch,
  testConfig,
  tokenOf,
  type Routes,
} from './harness.js';

/**
 * One test per finding from the security audit.
 *
 * Kept together rather than filed under the module each one touches: what these
 * assert is not "this function works" but "this specific way of being wrong does
 * not come back", and several of them were wrong in a way that looked right.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ok = {
  responseResult: { succeeded: true, errorCode: 0, slug: 'ok', message: 'ok' },
};

const PAGE = {
  id: 7,
  path: 'docs/setup',
  locale: 'en',
  title: 'Setup',
  description: 'd',
  contentType: 'markdown',
  editor: 'markdown',
  isPublished: true,
  isPrivate: false,
  publishStartDate: '',
  publishEndDate: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  authorId: 1,
  authorName: 'Ada',
  creatorId: 1,
  creatorName: 'Ada',
  tags: [],
};

describe('H1 — a caller-supplied pattern cannot wedge the server', () => {
  it('kills a catastrophically backtracking expression', async () => {
    // `(a+)+$` against ~40 characters does not finish in half a minute, and the
    // cost doubles per character. RegExp.test cannot be interrupted, so the
    // match runs in a worker that can be terminated.
    const started = Date.now();
    await expect(
      matchPages({
        pattern: '(a+)+$',
        ignoreCase: false,
        contextLines: 0,
        maxMatchesPerPage: 20,
        maxMatches: 200,
        pages: [{ id: 1, path: 'p', content: `${'a'.repeat(60)}b` }],
      })
    ).rejects.toBeInstanceOf(PatternTimeoutError);
    // Comfortably bounded, and nowhere near the minutes it took before.
    expect(Date.now() - started).toBeLessThan(MATCH_TIMEOUT_MS * 3);
  }, 30_000);

  it('still answers an ordinary pattern', async () => {
    const result = await matchPages({
      pattern: 'needle',
      ignoreCase: true,
      contextLines: 1,
      maxMatchesPerPage: 20,
      maxMatches: 200,
      pages: [{ id: 1, path: 'p', content: 'one\nNEEDLE\nthree\n' }],
    });
    expect(result.matchCount).toBe(1);
    expect(result.hits[0]?.matches[0]?.text).toBe('one\nNEEDLE\nthree');
  });

  it('leaves the server usable after a pattern was killed', async () => {
    stubFetch({
      'query ListPages': {
        data: {
          pages: { list: [{ id: 1, path: 'p', title: 'P', locale: 'en' }] },
        },
      },
      'query GetPageContent': {
        data: {
          pages: {
            single: {
              id: 1,
              path: 'p',
              locale: 'en',
              contentType: 'markdown',
              content: `${'a'.repeat(60)}b`,
            },
          },
        },
      },
      'query GetPageMetadata': { data: { pages: { single: PAGE } } },
    });
    const { call, close } = await connect();
    const killed = await call('grep_pages', { pattern: '(a+)+$' });
    expect(killed.isError).toBe(true);
    expect(JSON.stringify(killed)).toContain('did not finish');
    // The point of the worker: this call still works.
    const after = await call('get_page', { page_id: 7, mode: 'metadata' });
    expect(after.isError).toBeFalsy();
    await close();
  }, 30_000);
});

describe('H2/H3/L2 — a confirmation binds content, not a summary of it', () => {
  const routes: Routes = {
    'query ListGroups': { data: { groups: { list: [] } } },
    'query GetGroup': { data: { groups: { single: { id: 1 } } } },
    'mutation UpdateGroup': { data: { groups: { update: ok } } },
    'mutation UpdateUser': { data: { users: { update: ok } } },
    'mutation UpdateTag': { data: { pages: { updateTag: ok } } },
  };

  it('will not swap one permission for another of equal count', async () => {
    // The whole instance hangs off this: ["read:pages"] and ["manage:system"]
    // are both one permission, so a key built from the count made a
    // confirmation for a harmless narrowing execute a handover.
    stubFetch(routes);
    const { text, call, close } = await connect();
    const prompt = await text('update_group', {
      group_id: 1,
      name: 'G',
      permissions: ['read:pages'],
      page_rules: [],
    });
    const escalated = await call('update_group', {
      group_id: 1,
      name: 'G',
      permissions: ['manage:system'],
      page_rules: [],
      confirm_token: tokenOf(prompt),
    });
    expect(escalated.isError).toBe(true);
    await close();
  });

  it('names the permissions in the prompt, so the second turn can see them', async () => {
    stubFetch(routes);
    const { text, close } = await connect();
    const prompt = await text('update_group', {
      group_id: 1,
      name: 'G',
      permissions: ['manage:system'],
      page_rules: [],
    });
    expect(prompt).toContain('manage:system');
    await close();
  });

  it('will not repoint a sign-in address on a token issued for a job title', async () => {
    stubFetch(routes);
    const { text, call, close } = await connect();
    const prompt = await text('update_user', {
      user_id: 1,
      job_title: 'Tester',
    });
    const hijack = await call('update_user', {
      user_id: 1,
      email: 'attacker@example.test',
      confirm_token: tokenOf(prompt),
    });
    expect(hijack.isError).toBe(true);
    await close();
  });

  it('will not change a tag title on a token issued for a different one', async () => {
    stubFetch(routes);
    const { text, call, close } = await connect();
    const prompt = await text('update_tag', {
      tag_id: 1,
      tag: 'docs',
      title: 'Documentation',
    });
    const other = await call('update_tag', {
      tag_id: 1,
      tag: 'docs',
      title: 'Something else entirely',
      confirm_token: tokenOf(prompt),
    });
    expect(other.isError).toBe(true);
    await close();
  });

  it('the key is order-independent only because roles are labelled', () => {
    // setResourceKey sorts, so a bare pair of values makes a→b and b→a the same
    // confirmation. The labels are what keeps them apart.
    expect(setResourceKey('op', ['de', 'en'])).toBe(
      setResourceKey('op', ['en', 'de'])
    );
    expect(setResourceKey('op', ['from:de', 'to:en'])).not.toBe(
      setResourceKey('op', ['from:en', 'to:de'])
    );
  });
});

describe('H4/M1/M2 — the path scope covers what the documentation claims', () => {
  const scoped = testConfig({ allowedPaths: 'docs' });

  const assetRoutes: Routes = {
    'query ListAssetFolders': ({ variables }) =>
      variables.parentFolderId === 0
        ? {
            data: {
              assets: { folders: [{ id: 5, slug: 'docs', name: 'Docs' }] },
            },
          }
        : { data: { assets: { folders: [] } } },
    'query ListAssets': ({ variables }) =>
      variables.folderId === 9
        ? { data: { assets: { list: [{ id: 42, filename: 'x.png' }] } } }
        : { data: { assets: { list: [] } } },
    'mutation CreateAssetFolder': { data: { assets: { createFolder: ok } } },
    'mutation DeleteAsset': { data: { assets: { deleteAsset: ok } } },
  };

  it('refuses an upload into a folder outside the scope', async () => {
    stubFetch(assetRoutes);
    const { call, close } = await connect(scoped);
    const result = await call('upload_asset', {
      filename: 'a.png',
      content_base64: Buffer.from('x').toString('base64'),
      folder_id: 9,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('WIKIJS_ALLOWED_PATHS');
    await close();
  });

  it('refuses an upload into the asset root while a scope is set', async () => {
    stubFetch(assetRoutes);
    const { call, close } = await connect(scoped);
    const result = await call('upload_asset', {
      filename: 'a.png',
      content_base64: Buffer.from('x').toString('base64'),
    });
    expect(result.isError).toBe(true);
    await close();
  });

  it('allows an upload into a folder inside the scope', async () => {
    let uploaded = false;
    const routes = { ...assetRoutes };
    stubFetch(routes);
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input).endsWith('/u')) {
          uploaded = true;
          return new Response('ok', {
            headers: { 'content-type': 'text/plain' },
          });
        }
        return realFetch(input as string, init);
      })
    );
    const { call, close } = await connect(scoped);
    const result = await call('upload_asset', {
      filename: 'a.png',
      content_base64: Buffer.from('x').toString('base64'),
      folder_id: 5,
    });
    expect(result.isError).toBeFalsy();
    expect(uploaded).toBe(true);
    await close();
  });

  it('refuses the instance-wide writes rather than making a silent exception', async () => {
    stubFetch({ query: { data: {} }, mutation: { data: {} } });
    const { call, close } = await connect(scoped);
    for (const [name, args] of [
      ['purge_page_history', { older_than: 'P1Y' }],
      ['migrate_pages_locale', { source_locale: 'de', target_locale: 'en' }],
      ['update_tag', { tag_id: 1, tag: 'x', title: 'X' }],
      ['delete_tag', { tag_id: 1 }],
    ] as const) {
      const result = await call(name, args as Record<string, unknown>);
      expect(result.isError, name).toBe(true);
      expect(JSON.stringify(result), name).toContain('WIKIJS_ALLOWED_PATHS');
    }
    await close();
  });

  it('refuses comment edits it cannot place on a page', async () => {
    // Wiki.js does not report which page a comment belongs to, so the scope
    // cannot be honoured — saying so beats pretending it was.
    stubFetch({ query: { data: {} }, mutation: { data: {} } });
    const { call, close } = await connect(scoped);
    for (const name of ['update_comment', 'delete_comment']) {
      const result = await call(name, { comment_id: 1, content: 'x' });
      expect(result.isError, name).toBe(true);
      expect(JSON.stringify(result), name).toContain(
        'does not report which page'
      );
    }
    await close();
  });

  it('checks the page a new comment lands on', async () => {
    stubFetch({
      'query GetPageMetadata': {
        data: { pages: { single: { ...PAGE, path: 'other/page' } } },
      },
      'mutation CreateComment': {
        data: { comments: { create: { ...ok, id: 1 } } },
      },
    });
    const { call, close } = await connect(scoped);
    const result = await call('create_comment', { page_id: 7, content: 'hi' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('outside WIKIJS_ALLOWED_PATHS');
    await close();
  });

  it('walks the folder tree to place an asset for rename and delete', async () => {
    // Wiki.js has no parent pointer on a folder and cannot look an asset up by
    // id, so both have to be found by descending from the root.
    stubFetch({
      'query ListAssetFolders': ({ variables }) =>
        variables.parentFolderId === 0
          ? {
              data: {
                assets: {
                  folders: [
                    { id: 5, slug: 'docs', name: 'Docs' },
                    { id: 9, slug: 'private', name: 'Private' },
                  ],
                },
              },
            }
          : { data: { assets: { folders: [] } } },
      'query ListAssets': ({ variables }) =>
        variables.folderId === 9
          ? { data: { assets: { list: [{ id: 42, filename: 'secret.png' }] } } }
          : variables.folderId === 5
            ? { data: { assets: { list: [{ id: 7, filename: 'ok.png' }] } } }
            : { data: { assets: { list: [] } } },
      'mutation DeleteAsset': { data: { assets: { deleteAsset: ok } } },
      'mutation RenameAsset': { data: { assets: { renameAsset: ok } } },
    });
    const { confirmed, call, close } = await connect(scoped);

    const outside = await call('delete_asset', { asset_id: 42 });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside)).toContain('WIKIJS_ALLOWED_PATHS');

    const inside = await confirmed('delete_asset', { asset_id: 7 });
    expect(inside).toContain('Deleted asset 7');

    const renamed = await confirmed('rename_asset', {
      asset_id: 7,
      filename: 'better.png',
    });
    expect(renamed).toContain('Renamed asset 7');
    await close();
  });

  it('refuses rather than guessing when an asset cannot be placed', async () => {
    stubFetch({
      'query ListAssetFolders': { data: { assets: { folders: [] } } },
      'query ListAssets': { data: { assets: { list: [] } } },
    });
    const { call, close } = await connect(scoped);
    const result = await call('delete_asset', { asset_id: 999 });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Refusing rather than guessing');
    await close();
  });

  it('refuses a folder that is not under the asset root', async () => {
    stubFetch({
      'query ListAssetFolders': { data: { assets: { folders: [] } } },
    });
    const { call, close } = await connect(scoped);
    const result = await call('create_asset_folder', {
      slug: 'new',
      parent_folder_id: 77,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Refusing rather than guessing');
    await close();
  });

  it('leaves all of this alone when no scope is configured', async () => {
    stubFetch({
      'query GetPageMetadata': { data: { pages: { single: PAGE } } },
      'mutation CreateComment': {
        data: { comments: { create: { ...ok, id: 1 } } },
      },
    });
    const { call, close } = await connect();
    const result = await call('create_comment', { page_id: 7, content: 'hi' });
    expect(result.isError).toBeFalsy();
    await close();
  });
});

describe("Wiki.js' list limit counts tag rows, not pages", () => {
  // `pages.list` joins the tag table and applies `limit` to the joined rows, so
  // a page with three tags eats three of them. Asking for 50 on a 62-page wiki
  // returned between 13 and 23 pages depending on `orderBy` — and nothing said
  // so, which reads exactly like "the wiki has 13 pages".
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    path: `p${i}`,
    title: `P${i}`,
    locale: 'en',
  }));

  it('never sends a limit to Wiki.js', async () => {
    const stub = stubFetch({
      'query ListPages': { data: { pages: { list: many } } },
    });
    const { text, close } = await connect();
    await text('list_pages', { limit: 5 });
    expect(stub.calls[0]?.query).not.toContain('$limit');
    expect(stub.calls[0]?.variables).not.toHaveProperty('limit');
    await close();
  });

  it('applies the limit itself and reports the true total', async () => {
    stubFetch({ 'query ListPages': { data: { pages: { list: many } } } });
    const { json, close } = await connect();
    const out = (await json('list_pages', { limit: 5 })) as {
      shown: number;
      matching: number;
      note: string;
    };
    expect(out.shown).toBe(5);
    expect(out.matching).toBe(40);
    expect(out.note).toContain('35 further pages');
    await close();
  });

  it('says nothing extra when everything fits', async () => {
    stubFetch({
      'query ListPages': { data: { pages: { list: many.slice(0, 3) } } },
    });
    const { json, close } = await connect();
    const out = (await json('list_pages', {})) as {
      shown: number;
      note?: string;
    };
    expect(out.shown).toBe(3);
    expect(out.note).toBeUndefined();
    await close();
  });

  it('grep_pages bounds the page list itself, and says what it skipped', async () => {
    const lots = Array.from({ length: 260 }, (_, i) => ({
      id: i + 1,
      path: `p${i}`,
      title: 'P',
      locale: 'en',
    }));
    stubFetch({
      'query ListPages': { data: { pages: { list: lots } } },
      'query GetPageContent': {
        data: {
          pages: {
            single: {
              id: 1,
              path: 'p',
              locale: 'en',
              contentType: 'markdown',
              content: 'nothing here\n',
            },
          },
        },
      },
    });
    const { json, close } = await connect();
    const out = (await json('grep_pages', {
      pattern: 'zzz',
      max_pages: 2,
    })) as {
      notes: string[];
    };
    expect(out.notes.join(' ')).toContain('260 pages');
    await close();
  });
});

describe('M2 — update_comment destroys writing that has no history', () => {
  it('is gated, like delete_comment', async () => {
    stubFetch({
      'mutation UpdateComment': { data: { comments: { update: ok } } },
    });
    const { call, close } = await connect();
    const first = await call('update_comment', {
      comment_id: 4,
      content: 'new',
    });
    expect(JSON.stringify(first)).toContain('confirm_token');
    await close();
  });

  it('declares itself destructive', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'update_comment');
    expect(tool?.annotations?.destructiveHint).toBe(true);
    await close();
  });
});

describe('M3/M4 — redaction catches names nobody listed, and secrets in URLs', () => {
  it('matches a credential-shaped field by substring, not by equality', () => {
    const out = redactSensitive({
      clientSecret: 'a',
      refreshToken: 'b',
      smtpPassword: 'c',
      oauthAccessKey: 'd',
    }) as Record<string, unknown>;
    for (const value of Object.values(out)) expect(value).toBe(REDACTED);
  });

  it('keeps the identifiers that merely contain a sensitive word', () => {
    const out = redactSensitive({
      providerKey: 'local',
      keyShort: 'ab12',
    }) as Record<string, string>;
    expect(out.providerKey).toBe('local');
    expect(out.keyShort).toBe('ab12');
  });

  it('strips a token embedded in a git repository URL', () => {
    // The ordinary way to configure Wiki.js' git storage module, and the field
    // name says nothing about a secret.
    const out = redactSensitive([
      {
        key: 'repoUrl',
        value: 'https://u:ghp_secrettoken@github.com/org/wiki.git',
      },
    ]) as Array<{ value: string }>;
    expect(out[0]?.value).not.toContain('ghp_secrettoken');
    expect(out[0]?.value).toContain('github.com/org/wiki.git');
  });

  it('leaves a URL without credentials alone', () => {
    expect(redactSensitive({ url: 'https://wiki.example.com/a' })).toEqual({
      url: 'https://wiki.example.com/a',
    });
  });
});

describe('M5 — the diff table is bounded by the product, not the sum', () => {
  it('declines a pair whose table would be hundreds of megabytes', () => {
    // 9000 + 9000 is under the line ceiling; 9000 × 9000 is 324 MB.
    const a = Array.from({ length: 9000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 9000 }, (_, i) => `b${i}`).join('\n');
    const started = Date.now();
    const result = unifiedDiff(a, b);
    expect(result.note).toMatch(/product/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still diffs a pair of ordinary page revisions', () => {
    const a = Array.from({ length: 800 }, (_, i) => `line ${i}`).join('\n');
    const result = unifiedDiff(a, a.replace('line 400', 'changed'));
    expect(result.note).toBeUndefined();
    expect(result.diff).toContain('+changed');
  });
});

describe('L1 — the result budget covers the envelope, not just the list', () => {
  it('bounds a result whose extra fields are oversized', () => {
    const result = budgetedList('items', [], {
      extra: { note: 'x'.repeat(MAX_RESULT_BYTES * 2) },
    });
    const text = result.content
      .map((part) => ('text' in part ? part.text : ''))
      .join('');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_RESULT_BYTES + 500);
  });
});

describe('L3 — a confirmation prompt cannot be padded with invisible characters', () => {
  it('refuses zero-width characters, which \\s does not cover', () => {
    for (const bad of ['a​b', 'a⁠b', 'a﻿b', 'a‎b']) {
      expect(() => identifier(bad, 'page path')).toThrow(/refusing to name/);
    }
  });
});

describe('L4 — an uploaded file cannot be script the wiki then serves', () => {
  it('refuses the active file types', async () => {
    stubFetch({ query: { data: {} } });
    const { call, close } = await connect();
    for (const filename of ['x.svg', 'x.html', 'x.htm', 'x.xml', 'x.svgz']) {
      const result = await call('upload_asset', {
        filename,
        content_base64: Buffer.from('<svg onload=alert(1)>').toString('base64'),
      });
      expect(result.isError, filename).toBe(true);
    }
    await close();
  });

  it('derives the content type from the extension rather than the caller', async () => {
    let sent: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const form = init?.body as FormData;
        sent = (form.getAll('mediaUpload').at(-1) as File).type;
        return new Response('ok', {
          headers: { 'content-type': 'text/plain' },
        });
      })
    );
    const { call, close } = await connect();
    await call('upload_asset', {
      filename: 'diagram.png',
      content_base64: Buffer.from('x').toString('base64'),
    });
    expect(sent).toBe('image/png');
    await close();
  });
});
