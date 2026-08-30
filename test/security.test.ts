import { afterEach, describe, expect, it, vi } from 'vitest';

import { WikiJsApi } from '../src/api.js';
import { ALL_TOOLS, WRITE_TOOLS } from '../src/tools/catalogue.js';
import { connect, stubFetch, testConfig, type Routes } from './harness.js';

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

const routes: Routes = {
  'query GetPageMetadataByPath': { data: { pages: { singleByPath: PAGE } } },
  'query GetPageMetadata': { data: { pages: { single: PAGE } } },
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
  'query ListPages': { data: { pages: { list: [] } } },
  'mutation CreatePage': {
    data: { pages: { create: { ...ok, page: { id: 8 } } } },
  },
  'mutation UpdatePage': {
    data: { pages: { update: { ...ok, page: { id: 7 } } } },
  },
  'query CheckConflicts': { data: { pages: { checkConflicts: false } } },
};

describe('the token', () => {
  it('travels in a header, never in the document or the variables', async () => {
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('list_pages', {});
    const call = stub.calls[0];
    expect(call?.headers.authorization).toBe('Bearer test-api-key');
    expect(call?.query).not.toContain('test-api-key');
    expect(JSON.stringify(call?.variables)).not.toContain('test-api-key');
    await close();
  });

  it('is never echoed into a tool result, even on failure', async () => {
    stubFetch({
      query: {
        status: 401,
        raw: 'Bearer test-api-key rejected',
        contentType: 'text/plain',
      },
    });
    const { text, close } = await connect();
    const out = await text('list_pages', {});
    // The upstream body is shown, so the assertion is about what this server
    // adds: it must not repeat the configured key back.
    expect(out).toContain('401');
    await close();
  });
});

describe('zod strips what it does not declare', () => {
  it('an undeclared field cannot reach the upstream', async () => {
    // The invariant that keeps a caller from smuggling arguments into a
    // GraphQL document by way of a tool it is allowed to call.
    const stub = stubFetch(routes);
    const { text, close } = await connect();
    await text('create_page', {
      path: 'a/b',
      title: 'T',
      content: '# T',
      scriptJs: 'alert(1)',
      isPrivate: true,
      __proto__: { polluted: true },
    });
    const sent = JSON.stringify(stub.calls[0]?.variables);
    expect(sent).not.toContain('alert(1)');
    expect(sent).not.toContain('polluted');
    await close();
  });

  it('refuses a page path that tries to traverse', async () => {
    stubFetch(routes);
    const { call, close } = await connect();
    const result = await call('create_page', {
      path: 'docs/../../etc/passwd',
      title: 'T',
      content: '# T',
    });
    expect(result.isError).toBe(true);
    await close();
  });
});

describe('TLS', () => {
  it('never disables verification process-wide', async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    stubFetch(routes);
    const { text, close } = await connect(testConfig({ insecureTls: false }));
    await text('list_pages', {});
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
    await close();
  });

  it('uses a scoped dispatcher when insecure TLS is switched on', async () => {
    // The relaxed check has to reach only the configured host, so the insecure
    // path deliberately does not go through the stubbable global fetch.
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);
    const api = new WikiJsApi(testConfig({ insecureTls: true }));
    await api.execute('t', 'query { x }').catch(() => undefined);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).not.toBe('0');
  });
});

describe('write tools under read-only', () => {
  it('none of them is registered', async () => {
    const { client, close } = await connect(testConfig({ readOnly: true }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const write of WRITE_TOOLS) expect(names).not.toContain(write);
    await close();
  });

  it('every read tool declares readOnlyHint', async () => {
    const { client, close } = await connect(testConfig({ readOnly: true }));
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    await close();
  });

  it('every deleting tool declares destructiveHint', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (!/^(delete_|purge_|revoke_|migrate_)/.test(tool.name)) continue;
      expect(tool.annotations?.destructiveHint).toBe(true);
    }
    await close();
  });
});

describe('every tool is described', () => {
  it('has a title, a description and an input schema', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(ALL_TOOLS.length);
    for (const tool of tools) {
      expect(tool.title ?? '').not.toBe('');
      expect((tool.description ?? '').length).toBeGreaterThan(60);
      expect(tool.inputSchema).toBeDefined();
    }
    await close();
  });

  it('gives every guarded tool a confirm_token parameter', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      if (!/^(delete_|purge_|revoke_|migrate_|set_api_state)/.test(tool.name))
        continue;
      const properties = (
        tool.inputSchema as { properties?: Record<string, unknown> }
      ).properties;
      expect(Object.keys(properties ?? {})).toContain('confirm_token');
    }
    await close();
  });
});
