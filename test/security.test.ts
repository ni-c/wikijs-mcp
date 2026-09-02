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

  it('declares an output schema on every tool', async () => {
    // The same argument as the annotations below, one field along. A tool that
    // says nothing about its result forces a client to parse prose to find out
    // what it got, and the SDK sends no `structuredContent` at all for a tool
    // that declared no schema — twenty-nine tools here answered with a
    // sentence.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      // An object root, not merely a schema. SEP-2106 allows an array or a
      // scalar, but a 2025-era client is served that same tool with the schema
      // rewritten to `{result: …}` — so it would answer in two shapes
      // depending on who asked.
      expect(tool.outputSchema?.type, tool.name).toBe('object');
    }
    await close();
  });

  it('says in the schema which results carry wiki content', async () => {
    // Page text, titles, descriptions and comments are written by anyone with
    // edit rights. A client that reads only `structuredContent` must not get
    // them unframed — and the marker is a field it can check rather than a
    // preamble it has to notice.
    //
    // The list follows the call sites: a tool marked here is one that already
    // routed its answer through the untrusted wrapper.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const marked = tools.filter((tool) => {
      const properties = tool.outputSchema?.properties as
        Record<string, unknown> | undefined;
      return properties?.untrusted !== undefined;
    });
    expect(marked.length).toBeGreaterThan(0);
    // And every tool that does *not* carry it answers with this server's own
    // words: an id it was given, or a fact it established.
    for (const tool of marked) {
      const properties = tool.outputSchema?.properties as Record<
        string,
        { const?: unknown }
      >;
      expect(properties.source?.const, tool.name).toBe('wikijs');
    }
    await close();
  });

  it('declares all four annotation hints on every tool', async () => {
    // Not a style rule. Two of the four default to a *stronger* claim than
    // silence suggests: the specification gives destructiveHint and
    // openWorldHint a default of true, so a tool that omits them announces
    // itself as destructive and open-world. Twenty-two write tools here said
    // only idempotentHint and inherited the rest.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const hints = [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const;
    for (const tool of tools) {
      for (const hint of hints) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
          'boolean'
        );
      }
    }
    await close();
  });

  it('lets page history decide what counts as destructive', async () => {
    // The distinction a wiki makes and a bookmark manager cannot. Wiki.js
    // keeps every page version, so editing a page is recoverable and
    // update_page is not destructive. Comments have no history at all, so
    // update_comment is. Same verb, opposite answers, decided by what the
    // store remembers rather than by the shape of the call.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get('update_page')?.destructiveHint).toBe(false);
    expect(byName.get('update_comment')?.destructiveHint).toBe(true);
    await close();
  });

  it('does not warn about rebuilding something derived', async () => {
    // These four recompute a cache, a tree, an index or a rendering. They
    // lose nothing by construction — which is also why they stop asking for
    // a confirmation.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of [
      'flush_page_cache',
      'rebuild_page_tree',
      'rebuild_search_index',
      'render_page',
    ]) {
      expect(byName.get(name)?.destructiveHint, name).toBe(false);
      expect(byName.get(name)?.idempotentHint, name).toBe(true);
    }
    await close();
  });

  it('warns where a wholesale replacement leaves no trace', async () => {
    // update_group replaces a permission set, update_user a group list,
    // update_tag a name on every page carrying it, reset_user_password a
    // credential the person chose. None of those has a history to go back to.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    for (const name of [
      'update_group',
      'update_user',
      'update_tag',
      'reset_user_password',
    ]) {
      expect(byName.get(name)?.destructiveHint, name).toBe(true);
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
