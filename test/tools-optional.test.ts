import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, stubFetch, testConfig, type Routes } from './harness.js';

/**
 * The optional arguments, exercised.
 *
 * Almost every tool here is a row of `x ?? default` expressions, and each one is
 * a branch that a happy-path test never takes. This file calls the tools once
 * with nothing but the required arguments and once with everything set, and
 * asserts on what reached the upstream — which is where a defaulting mistake
 * actually shows up.
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
  tags: [{ tag: 'docs', title: 'docs' }],
};

const routes: Routes = {
  'query GetPageMetadata': { data: { pages: { single: PAGE } } },
  'query GetPageMetadataByPath': { data: { pages: { singleByPath: PAGE } } },
  'query GetPageContent': {
    data: {
      pages: {
        single: {
          id: 7,
          path: 'docs/setup',
          locale: 'en',
          contentType: 'markdown',
          content: '# a\n',
        },
      },
    },
  },
  'query GetPageRender': {
    data: {
      pages: {
        single: { id: 7, path: 'docs/setup', locale: 'en', render: '<p>a</p>' },
      },
    },
  },
  'query ListPages': { data: { pages: { list: [] } } },
  'query PageTree': { data: { pages: { tree: [] } } },
  'query ListAssets': { data: { assets: { list: [] } } },
  'query ListAssetFolders': { data: { assets: { folders: [] } } },
  'query ListUsers': { data: { users: { list: [] } } },
  'query ListGroups': { data: { groups: { list: [] } } },
  'query ListComments': { data: { comments: { list: [] } } },
  'query ListLocales': {
    data: {
      localization: {
        locales: [{ code: 'en', isInstalled: true }],
        config: {},
      },
    },
  },
  'mutation CreatePage': {
    data: { pages: { create: { ...ok, page: { id: 8 } } } },
  },
  'mutation CreateAssetFolder': { data: { assets: { createFolder: ok } } },
  'mutation CreateComment': {
    data: { comments: { create: { ...ok, id: 3 } } },
  },
};

describe('defaults that reach the upstream', () => {
  it('list_pages defaults to the newest first, with no filters', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('list_pages', {});
    expect(stub.calls[0]?.variables).toEqual({
      limit: 50,
      orderBy: 'UPDATED',
      orderByDirection: 'DESC',
      tags: null,
      locale: null,
      creatorId: null,
      authorId: null,
    });
    await close();
  });

  it('list_pages passes every filter through when they are given', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('list_pages', {
      limit: 3,
      tags: ['a'],
      locale: 'de',
      creator_id: 4,
      author_id: 5,
      order_by: 'TITLE',
      direction: 'ASC',
    });
    expect(stub.calls[0]?.variables).toEqual({
      limit: 3,
      orderBy: 'TITLE',
      orderByDirection: 'ASC',
      tags: ['a'],
      locale: 'de',
      creatorId: 4,
      authorId: 5,
    });
    await close();
  });

  it('page tools fall back to the configured locale', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect(testConfig({ locale: 'de' }));
    await text('get_page', { path: 'docs/setup', mode: 'metadata' });
    expect(stub.calls[0]?.variables.locale).toBe('de');
    await close();
  });

  it('get_page serves the rendered HTML on request', async () => {
    stubFetch(routes);
    const { text, close } = await connect();
    expect(await text('get_page', { page_id: 7, mode: 'rendered' })).toContain(
      '<p>a</p>'
    );
    await close();
  });

  it('get_page_tree defaults to the root and to ALL', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('get_page_tree', {});
    expect(stub.calls[0]?.variables).toMatchObject({
      path: '',
      mode: 'ALL',
      locale: 'en',
      includeAncestors: false,
    });
    await close();
  });

  it('get_page_tree passes an explicit mode and ancestors', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('get_page_tree', {
      path: 'docs',
      mode: 'FOLDERS',
      locale: 'de',
      include_ancestors: true,
    });
    expect(stub.calls[0]?.variables).toMatchObject({
      path: 'docs',
      mode: 'FOLDERS',
      locale: 'de',
      includeAncestors: true,
    });
    await close();
  });

  it('create_page defaults to a published markdown page with no tags', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('create_page', { path: 'a/b', title: 'T', content: '# T' });
    expect(stub.calls[0]?.variables).toMatchObject({
      description: '',
      locale: 'en',
      tags: [],
      editor: 'markdown',
      isPublished: true,
      isPrivate: false,
    });
    await close();
  });

  it('create_page honours a draft, a locale and another editor', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('create_page', {
      path: 'a/b',
      title: 'T',
      content: '<p>T</p>',
      description: 'd',
      locale: 'de',
      tags: ['x'],
      editor: 'code',
      is_published: false,
      is_private: true,
    });
    expect(stub.calls[0]?.variables).toMatchObject({
      description: 'd',
      locale: 'de',
      tags: ['x'],
      editor: 'code',
      isPublished: false,
      isPrivate: true,
    });
    await close();
  });

  it('asset tools default to the root folder and to every kind', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('list_assets', {});
    expect(stub.calls[0]?.variables).toEqual({ folderId: 0, kind: 'ALL' });
    await text('list_assets', { folder_id: 4, kind: 'IMAGE' });
    expect(stub.calls[1]?.variables).toEqual({ folderId: 4, kind: 'IMAGE' });
    await text('list_asset_folders', { parent_folder_id: 2 });
    expect(stub.calls[2]?.variables).toEqual({ parentFolderId: 2 });
    await close();
  });

  it('create_asset_folder sends a null name rather than inventing one', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('create_asset_folder', { slug: 'img' });
    expect(stub.calls[0]?.variables).toEqual({
      parentFolderId: 0,
      slug: 'img',
      name: null,
    });
    await close();
  });

  it('upload_asset defaults the content type to octet-stream', async () => {
    let body: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_i: unknown, init?: RequestInit) => {
        body = init?.body as FormData;
        return new Response('ok', {
          headers: { 'content-type': 'text/plain' },
        });
      })
    );
    const { text, close } = await connect();
    await text('upload_asset', { filename: 'a.bin', content_base64: 'AAA=' });
    const file = body?.getAll('mediaUpload').at(-1) as File;
    expect(file.type).toBe('application/octet-stream');
    await close();
  });

  it('user and group listings send null filters by default', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('list_users', {});
    expect(stub.calls[0]?.variables).toEqual({ filter: null, orderBy: null });
    await text('list_groups', { filter: 'ad', order_by: 'name' });
    expect(stub.calls[1]?.variables).toEqual({ filter: 'ad', orderBy: 'name' });
    await close();
  });

  it('list_users applies its client-side limit, since Wiki.js has none', async () => {
    stubFetch({
      ...routes,
      'query ListUsers': {
        data: { users: { list: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
      },
    });
    const { json, close } = await connect();
    const out = (await json('list_users', { limit: 2 })) as {
      shown: number;
      total: number;
    };
    expect(out).toMatchObject({ shown: 2, total: 3 });
    await close();
  });

  it('list_locales can be asked for everything Wiki.js could download', async () => {
    stubFetch({
      ...routes,
      'query ListLocales': {
        data: {
          localization: {
            locales: [
              { code: 'en', isInstalled: true },
              { code: 'zz', isInstalled: false },
            ],
            config: {},
          },
        },
      },
    });
    const { json, close } = await connect();
    expect(
      (await json('list_locales', { installed_only: false })) as {
        shown: number;
      }
    ).toMatchObject({ shown: 2 });
    await close();
  });

  it('create_comment passes an explicit reply target through', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('create_comment', { page_id: 7, content: 'x', reply_to: 5 });
    expect(stub.calls[0]?.variables.replyTo).toBe(5);
    await close();
  });

  it('grep_pages honours case sensitivity and context width', async () => {
    stubFetch({
      ...routes,
      'query ListPages': {
        data: {
          pages: { list: [{ id: 7, path: 'a', title: 'A', locale: 'en' }] },
        },
      },
      'query GetPageContent': {
        data: {
          pages: {
            single: {
              id: 7,
              path: 'a',
              locale: 'en',
              contentType: 'markdown',
              content: 'one\nNEEDLE\nthree\n',
            },
          },
        },
      },
    });
    const { json, close } = await connect();
    const sensitive = (await json('grep_pages', {
      pattern: 'needle',
      ignore_case: false,
    })) as { matches: number };
    expect(sensitive.matches).toBe(0);
    const insensitive = (await json('grep_pages', {
      pattern: 'needle',
      context_lines: 0,
    })) as { pages: Array<{ matches: Array<{ text: string }> }> };
    expect(insensitive.pages[0]?.matches[0]?.text).toBe('NEEDLE');
    await close();
  });

  it('grep_pages says when its filters left pages unfetched', async () => {
    stubFetch({
      ...routes,
      'query ListPages': {
        data: {
          pages: {
            list: Array.from({ length: 5 }, (_, i) => ({
              id: i + 1,
              path: `p${i}`,
              title: 'P',
              locale: 'en',
            })),
          },
        },
      },
      'query GetPageContent': {
        data: {
          pages: {
            single: {
              id: 1,
              path: 'p0',
              locale: 'en',
              contentType: 'markdown',
              content: 'x\n',
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
      pagesScanned: number;
    };
    expect(out.pagesScanned).toBe(2);
    expect(out.notes.join(' ')).toContain('Raise max_pages');
    await close();
  });

  it('grep_pages reports pages it was not allowed to read', async () => {
    stubFetch({
      ...routes,
      'query ListPages': {
        data: {
          pages: { list: [{ id: 7, path: 'a', title: 'A', locale: 'en' }] },
        },
      },
      'query GetPageContent': {
        errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
      },
    });
    const { json, close } = await connect();
    const out = (await json('grep_pages', { pattern: 'x' })) as {
      notes: string[];
    };
    expect(out.notes.join(' ')).toContain('read:source');
    await close();
  });

  it('grep_pages narrows by path prefix', async () => {
    stubFetch({
      ...routes,
      'query ListPages': {
        data: {
          pages: {
            list: [
              { id: 1, path: 'docs/a', title: 'A', locale: 'en' },
              { id: 2, path: 'other/b', title: 'B', locale: 'en' },
            ],
          },
        },
      },
      'query GetPageContent': {
        data: {
          pages: {
            single: {
              id: 1,
              path: 'docs/a',
              locale: 'en',
              contentType: 'markdown',
              content: 'hit\n',
            },
          },
        },
      },
    });
    const { json, close } = await connect();
    const out = (await json('grep_pages', {
      pattern: 'hit',
      path_prefix: 'docs/',
    })) as {
      pagesScanned: number;
    };
    expect(out.pagesScanned).toBe(1);
    await close();
  });
});
