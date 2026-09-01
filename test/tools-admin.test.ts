import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, stubFetch, type Routes } from './harness.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A succeeded mutation envelope, which is what most of these return. */
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

describe('page tree, links and tags', () => {
  it('lists a tree level', async () => {
    stubFetch({
      'query PageTree': {
        data: {
          pages: {
            tree: [
              {
                id: 1,
                path: 'docs/setup',
                depth: 2,
                title: 'Setup',
                isFolder: false,
              },
            ],
          },
        },
      },
    });
    const { json, close } = await connect();
    const out = (await json('get_page_tree', { path: 'docs' })) as {
      count: number;
    };
    expect(out.count).toBe(1);
    await close();
  });

  it('returns the link graph for one locale', async () => {
    stubFetch({
      'query PageLinks': {
        data: {
          pages: { links: [{ id: 1, path: 'a', title: 'A', links: ['b'] }] },
        },
      },
    });
    const { json, close } = await connect();
    expect(
      (await json('list_page_links', {})) as { count: number }
    ).toMatchObject({
      count: 1,
    });
    await close();
  });

  it('lists and searches tags', async () => {
    stubFetch({
      'query ListTags': {
        data: { pages: { tags: [{ id: 1, tag: 'docs', title: 'docs' }] } },
      },
      'query SearchTags': { data: { pages: { searchTags: ['docs'] } } },
    });
    const { json, close } = await connect();
    expect((await json('list_tags')) as { count: number }).toMatchObject({
      count: 1,
    });
    expect(
      (await json('search_tags', { query: 'do' })) as { count: number }
    ).toMatchObject({ count: 1 });
    await close();
  });

  it('renames and deletes a tag behind a confirmation', async () => {
    const stub = stubFetch({
      'mutation UpdateTag': { data: { pages: { updateTag: ok } } },
      'mutation DeleteTag': { data: { pages: { deleteTag: ok } } },
    });
    const { confirmed, close } = await connect();
    expect(
      await confirmed('update_tag', {
        tag_id: 1,
        tag: 'new',
        title: 'New',
      })
    ).toContain('Renamed tag 1');
    expect(await confirmed('delete_tag', { tag_id: 1 })).toContain(
      'Deleted tag 1'
    );
    expect(stub.calls.filter((c) => c.query.includes('mutation'))).toHaveLength(
      2
    );
    await close();
  });

  it('rejects a tag containing a space, which Wiki.js would split', async () => {
    stubFetch({ query: { data: {} } });
    const { call, close } = await connect();
    const result = await call('update_tag', {
      tag_id: 1,
      tag: 'two words',
      title: 'x',
    });
    expect(result.isError).toBe(true);
    await close();
  });
});

describe('history tools', () => {
  const routes: Routes = {
    'query GetPageMetadata': { data: { pages: { single: PAGE } } },
    'query PageHistory': {
      data: {
        pages: {
          history: {
            total: 2,
            trail: [
              {
                versionId: 9,
                versionDate: '2026-01-02T00:00:00.000Z',
                authorName: 'Ada',
                actionType: 'edit',
              },
              {
                versionId: 8,
                versionDate: '2026-01-01T00:00:00.000Z',
                authorName: 'Ada',
                actionType: 'initial',
              },
            ],
          },
        },
      },
    },
    'query PageVersion': {
      data: {
        pages: {
          version: {
            versionId: 8,
            versionDate: '2026-01-01T00:00:00.000Z',
            authorName: 'Ada',
            content: 'one\ntwo\n',
          },
        },
      },
    },
    'query GetPageContent': {
      data: {
        pages: {
          single: {
            id: 7,
            path: 'docs/setup',
            locale: 'en',
            contentType: 'markdown',
            content: 'one\nTWO\n',
          },
        },
      },
    },
    'query ConflictLatest': {
      data: {
        pages: {
          conflictLatest: { id: 7, authorName: 'Bob', path: 'docs/setup' },
        },
      },
    },
    'mutation RestoreVersion': { data: { pages: { restore: ok } } },
  };

  it('paginates history — the one Wiki.js query that really does', async () => {
    const stub = stubFetch(routes);
    const { json, close } = await connect();
    const out = (await json('list_page_history', {
      page_id: 7,
      page: 1,
      page_size: 10,
    })) as {
      total: number;
    };
    expect(out.total).toBe(2);
    const call = stub.calls.find((c) => c.query.includes('PageHistory'));
    expect(call?.variables).toMatchObject({ offsetPage: 1, offsetSize: 10 });
    await close();
  });

  it('returns one stored version, marked untrusted', async () => {
    stubFetch(routes);
    const { text, close } = await connect();
    const out = await text('get_page_version', { page_id: 7, version_id: 8 });
    expect(out).toContain('untrusted content');
    expect(out).toContain('"versionId": 8');
    await close();
  });

  it('diffs a version against the live page', async () => {
    stubFetch(routes);
    const { json, close } = await connect();
    const out = (await json('diff_page_versions', {
      page_id: 7,
      from_version: 8,
    })) as {
      to: string;
      linesAdded: number;
      linesRemoved: number;
      diff: string;
    };
    expect(out.to).toBe('current');
    expect(out.linesAdded).toBe(1);
    expect(out.linesRemoved).toBe(1);
    expect(out.diff).toContain('+TWO');
    await close();
  });

  it('diffs two stored versions', async () => {
    stubFetch(routes);
    const { json, close } = await connect();
    const out = (await json('diff_page_versions', {
      page_id: 7,
      from_version: 8,
      to_version: 9,
    })) as { to: string; identical: boolean };
    expect(out.to).toBe('9');
    // Both sides come from the same stubbed version document here.
    expect(out.identical).toBe(true);
    await close();
  });

  it('shows the newer version behind a conflict', async () => {
    stubFetch(routes);
    const { text, close } = await connect();
    expect(await text('get_page_conflict', { page_id: 7 })).toContain('Bob');
    await close();
  });

  it('restores a version behind a confirmation', async () => {
    stubFetch(routes);
    const { confirmed, close } = await connect();
    expect(
      await confirmed('restore_page_version', {
        page_id: 7,
        version_id: 8,
      })
    ).toContain('Restored page 7');
    await close();
  });
});

describe('asset tools', () => {
  const routes: Routes = {
    'query ListAssets': {
      data: {
        assets: {
          list: [
            {
              id: 3,
              filename: 'a.png',
              ext: '.png',
              kind: 'IMAGE',
              mime: 'image/png',
              fileSize: 10,
            },
          ],
        },
      },
    },
    'query ListAssetFolders': {
      data: { assets: { folders: [{ id: 1, slug: 'img', name: 'Images' }] } },
    },
    'mutation CreateAssetFolder': { data: { assets: { createFolder: ok } } },
    'mutation RenameAsset': { data: { assets: { renameAsset: ok } } },
    'mutation DeleteAsset': { data: { assets: { deleteAsset: ok } } },
  };

  it('lists assets and folders', async () => {
    stubFetch(routes);
    const { json, close } = await connect();
    expect((await json('list_assets', {})) as { count: number }).toMatchObject({
      count: 1,
    });
    expect(
      (await json('list_asset_folders', {})) as { parentFolderId: number }
    ).toMatchObject({ parentFolderId: 0 });
    await close();
  });

  it('creates a folder, renames and deletes an asset', async () => {
    stubFetch(routes);
    const { confirmed, text, close } = await connect();
    expect(await text('create_asset_folder', { slug: 'img' })).toContain(
      'Created asset folder'
    );
    expect(
      await confirmed('rename_asset', { asset_id: 3, filename: 'b.png' })
    ).toContain('Renamed asset 3');
    expect(await confirmed('delete_asset', { asset_id: 3 })).toContain(
      'Deleted asset 3'
    );
    await close();
  });

  it('rejects a filename with traversal or no extension', async () => {
    stubFetch(routes);
    const { call, close } = await connect();
    for (const filename of ['../evil.png', 'noextension', '/abs.png']) {
      expect(
        (await call('rename_asset', { asset_id: 3, filename })).isError
      ).toBe(true);
    }
    await close();
  });

  it('uploads through the editor route, since GraphQL has no mutation for it', async () => {
    let uploaded: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        uploaded = init;
        return new Response('ok', {
          headers: { 'content-type': 'text/plain' },
        });
      })
    );
    const { json, close } = await connect();
    const out = (await json('upload_asset', {
      filename: 'a.txt',
      content_base64: Buffer.from('hello').toString('base64'),
      content_type: 'text/plain',
    })) as { bytes: number };
    expect(out.bytes).toBe(5);
    expect(uploaded?.body).toBeInstanceOf(FormData);
    await close();
  });

  it('refuses an oversized or empty upload before decoding it anywhere else', async () => {
    stubFetch(routes);
    const { call, close } = await connect();
    const tooBig = await call('upload_asset', {
      filename: 'a.bin',
      content_base64: 'A'.repeat(12 * 1024 * 1024),
    });
    expect(tooBig.isError).toBe(true);
    const empty = await call('upload_asset', {
      filename: 'a.bin',
      content_base64: '!!!',
    });
    expect(empty.isError).toBe(true);
    await close();
  });
});

describe('comment tools', () => {
  const routes: Routes = {
    'query ListComments': {
      data: {
        comments: { list: [{ id: 4, content: 'hi', authorName: 'Ada' }] },
      },
    },
    'query GetComment': {
      data: { comments: { single: { id: 4, content: 'hi' } } },
    },
    'mutation UpdateComment': { data: { comments: { update: ok } } },
    'mutation DeleteComment': { data: { comments: { delete: ok } } },
  };

  it('lists comments by path, which is the one place Wiki.js wants a path', async () => {
    const stub = stubFetch(routes);
    const { json, close } = await connect();
    await json('list_comments', { path: 'docs/setup' });
    expect(stub.calls[0]?.variables).toMatchObject({
      path: 'docs/setup',
      locale: 'en',
    });
    await close();
  });

  it('marks a comment as untrusted content', async () => {
    stubFetch(routes);
    const { text, close } = await connect();
    expect(await text('get_comment', { comment_id: 4 })).toContain(
      'untrusted content'
    );
    await close();
  });

  it('edits and deletes a comment', async () => {
    stubFetch(routes);
    const { confirmed, close } = await connect();
    expect(
      await confirmed('update_comment', {
        comment_id: 4,
        content: 'edited',
      })
    ).toContain('Updated comment 4');
    expect(await confirmed('delete_comment', { comment_id: 4 })).toContain(
      'Deleted comment 4'
    );
    await close();
  });
});

describe('user and group tools', () => {
  const routes: Routes = {
    'query ListUsers': {
      data: {
        users: {
          list: [
            { id: 1, name: 'Ada', email: 'ada@example.test', isActive: true },
          ],
        },
      },
    },
    'query SearchUsers': {
      data: {
        users: { search: [{ id: 1, name: 'Ada', email: 'ada@example.test' }] },
      },
    },
    'query GetUser': {
      data: { users: { single: { id: 1, name: 'Ada', groups: [] } } },
    },
    'mutation UpdateUser': { data: { users: { update: ok } } },
    'mutation DeleteUser': { data: { users: { delete: ok } } },
    'mutation ActivateUser': { data: { users: { activate: ok } } },
    'mutation DeactivateUser': { data: { users: { deactivate: ok } } },
    'mutation VerifyUser': { data: { users: { verify: ok } } },
    'mutation EnableTfa': { data: { users: { enableTFA: ok } } },
    'mutation DisableTfa': { data: { users: { disableTFA: ok } } },
    'mutation ResetPassword': { data: { users: { resetPassword: ok } } },
    'query ListGroups': {
      data: { groups: { list: [{ id: 1, name: 'Admins', isSystem: true }] } },
    },
    'query GetGroup': {
      data: {
        groups: {
          single: {
            id: 1,
            name: 'Admins',
            permissions: ['manage:system'],
            pageRules: [],
          },
        },
      },
    },
    'mutation CreateGroup': {
      data: { groups: { create: { ...ok, group: { id: 5, name: 'New' } } } },
    },
    'mutation UpdateGroup': { data: { groups: { update: ok } } },
    'mutation DeleteGroup': { data: { groups: { delete: ok } } },
    'mutation AssignUser': { data: { groups: { assignUser: ok } } },
    'mutation UnassignUser': { data: { groups: { unassignUser: ok } } },
  };

  it('lists, searches and reads users', async () => {
    stubFetch(routes);
    const { json, close } = await connect();
    expect((await json('list_users', {})) as { total: number }).toMatchObject({
      total: 1,
    });
    expect(
      (await json('search_users', { query: 'ada' })) as { count: number }
    ).toMatchObject({
      count: 1,
    });
    expect(
      (await json('get_user', { user_id: 1 })) as { user: { id: number } }
    ).toMatchObject({
      user: { id: 1 },
    });
    await close();
  });

  it('gates every user write behind a confirmation', async () => {
    // Deactivating locks somebody out and disabling 2FA weakens their account:
    // neither should follow from a single sentence in a page the model just read.
    stubFetch(routes);
    const { call, close } = await connect();
    for (const [name, args] of [
      ['update_user', { user_id: 1, name: 'X' }],
      ['delete_user', { user_id: 1, replace_with_user_id: 2 }],
      ['set_user_active', { user_id: 1, active: false }],
      ['verify_user', { user_id: 1 }],
      ['set_user_tfa', { user_id: 1, enabled: false }],
      ['reset_user_password', { user_id: 1 }],
    ] as const) {
      const first = await call(name, args as Record<string, unknown>);
      expect(JSON.stringify(first)).toContain('confirm_token');
    }
    await close();
  });

  it('carries every user write through to the mutation once confirmed', async () => {
    const stub = stubFetch(routes);
    const { confirmed, close } = await connect();
    expect(await confirmed('update_user', { user_id: 1, name: 'X' })).toContain(
      'Updated user 1'
    );
    expect(
      await confirmed('update_user', { user_id: 1, groups: [2, 3] })
    ).toContain('Updated user 1');
    expect(
      await confirmed('delete_user', {
        user_id: 1,
        replace_with_user_id: 2,
      })
    ).toContain('Deleted user 1');
    expect(await confirmed('verify_user', { user_id: 1 })).toContain(
      'User 1 is verified'
    );
    expect(
      await confirmed('set_user_tfa', { user_id: 1, enabled: false })
    ).toContain('now off');
    expect(await confirmed('reset_user_password', { user_id: 1 })).toContain(
      'Password reset started'
    );
    for (const op of [
      'UpdateUser',
      'DeleteUser',
      'VerifyUser',
      'DisableTfa',
      'ResetPassword',
    ]) {
      expect(stub.calls.some((c) => c.query.includes(op))).toBe(true);
    }
    await close();
  });

  it('says so when a group list replaces the whole membership', async () => {
    stubFetch(routes);
    const { text, close } = await connect();
    const prompt = await text('update_user', { user_id: 1, groups: [2] });
    expect(prompt).toContain('set their membership to 1 group(s)');
    expect(prompt).toContain('replaced wholesale');
    const profileOnly = await text('update_user', { user_id: 1, name: 'X' });
    expect(profileOnly).toContain('Only profile fields change');
    // Changing the sign-in address is not a profile field, and the prompt must
    // not say it is.
    const withEmail = await text('update_user', {
      user_id: 1,
      email: 'new@example.test',
    });
    expect(withEmail).toContain('sign-in address');
    expect(withEmail).not.toContain('Only profile fields change');
    await close();
  });

  it('creates a user with an explicit provider and welcome mail', async () => {
    const stub = stubFetch({
      ...routes,
      'mutation CreateUser': {
        data: { users: { create: { ...ok, user: null } } },
      },
    });
    const { confirmed, close } = await connect();
    await confirmed('create_user', {
      email: 'new@example.test',
      name: 'New',
      provider_key: 'azure',
      groups: [2],
      must_change_password: true,
      send_welcome_email: true,
    });
    const call = stub.calls.find((c) => c.query.includes('CreateUser'));
    expect(call?.variables).toMatchObject({
      providerKey: 'azure',
      groups: [2],
      mustChangePassword: true,
      sendWelcomeEmail: true,
      passwordRaw: null,
    });
    await close();
  });

  it('says so when a created account cannot be found afterwards', async () => {
    stubFetch({
      ...routes,
      'mutation CreateUser': {
        data: { users: { create: { ...ok, user: null } } },
      },
      'query SearchUsers': { data: { users: { search: [] } } },
    });
    const { confirmed, close } = await connect();
    const out = await confirmed('create_user', {
      email: 'ghost@example.test',
      name: 'Ghost',
    });
    expect(out).toContain('search_users to locate it');
    await close();
  });

  it('activates and deactivates through the right mutation', async () => {
    const stub = stubFetch(routes);
    const { confirmed, close } = await connect();
    await confirmed('set_user_active', { user_id: 1, active: true });
    await confirmed('set_user_active', { user_id: 1, active: false });
    expect(stub.calls.some((c) => c.query.includes('ActivateUser'))).toBe(true);
    expect(stub.calls.some((c) => c.query.includes('DeactivateUser'))).toBe(
      true
    );
    await close();
  });

  it('will not reuse a 2FA confirmation for the opposite direction', async () => {
    stubFetch(routes);
    const { text, call, close } = await connect();
    const prompt = await text('set_user_tfa', { user_id: 1, enabled: true });
    const token = /confirm_token="([0-9a-f]{32})"/.exec(prompt)?.[1];
    const wrong = await call('set_user_tfa', {
      user_id: 1,
      enabled: false,
      confirm_token: token,
    });
    expect(wrong.isError).toBe(true);
    await close();
  });

  it('reads groups with their permissions and page rules', async () => {
    stubFetch(routes);
    const { json, close } = await connect();
    const out = (await json('get_group', { group_id: 1 })) as {
      group: { permissions: string[] };
    };
    expect(out.group.permissions).toEqual(['manage:system']);
    await close();
  });

  it('creates a group without a confirmation, since it grants nothing yet', async () => {
    stubFetch(routes);
    const { json, close } = await connect();
    expect(
      (await json('create_group', { name: 'New' })) as {
        created: { id: number };
      }
    ).toMatchObject({ created: { id: 5 } });
    await close();
  });

  it('gates the group writes that decide access', async () => {
    stubFetch(routes);
    const { confirmed, close } = await connect();
    expect(
      await confirmed('update_group', {
        group_id: 1,
        name: 'Admins',
        permissions: ['read:pages'],
        page_rules: [],
      })
    ).toContain('Updated group 1');
    expect(await confirmed('delete_group', { group_id: 1 })).toContain(
      'Deleted group 1'
    );
    expect(
      await confirmed('assign_user_to_group', { group_id: 1, user_id: 2 })
    ).toContain('Added user 2');
    expect(
      await confirmed('unassign_user_from_group', {
        group_id: 1,
        user_id: 2,
      })
    ).toContain('Removed user 2');
    await close();
  });

  it('binds an update_group confirmation to the size of the rule set', async () => {
    stubFetch(routes);
    const { text, call, close } = await connect();
    const prompt = await text('update_group', {
      group_id: 1,
      name: 'Admins',
      permissions: ['read:pages'],
      page_rules: [],
    });
    const token = /confirm_token="([0-9a-f]{32})"/.exec(prompt)?.[1];
    const swapped = await call('update_group', {
      group_id: 1,
      name: 'Admins',
      permissions: ['read:pages', 'manage:system'],
      page_rules: [],
      confirm_token: token,
    });
    expect(swapped.isError).toBe(true);
    await close();
  });
});

describe('system and maintenance tools', () => {
  const routes: Routes = {
    'query ListLocales': {
      data: {
        localization: {
          locales: [
            { code: 'en', name: 'English', isInstalled: true },
            { code: 'zz', name: 'Never installed', isInstalled: false },
          ],
          config: { locale: 'en', namespacing: false },
        },
      },
    },
    'query NavigationTree': {
      data: { navigation: { config: { mode: 'MIXED' }, tree: [] } },
    },
    'query ListSearchEngines': {
      data: {
        search: {
          searchEngines: [
            { key: 'db', title: 'Database - Basic', isEnabled: true },
          ],
        },
      },
    },
    'query ListApiKeys': {
      data: {
        authentication: {
          apiState: true,
          apiKeys: [{ id: 1, name: 'k', keyShort: 'ab', isRevoked: false }],
        },
      },
    },
    'mutation RevokeApiKey': { data: { authentication: { revokeApiKey: ok } } },
    'mutation SetApiState': { data: { authentication: { setApiState: ok } } },
    'mutation RenderPage': { data: { pages: { render: ok } } },
    'mutation FlushCache': { data: { pages: { flushCache: ok } } },
    'mutation RebuildTree': { data: { pages: { rebuildTree: ok } } },
    'mutation RebuildSearchIndex': { data: { search: { rebuildIndex: ok } } },
    'mutation PurgeHistory': { data: { pages: { purgeHistory: ok } } },
    'mutation MigrateLocale': {
      data: { pages: { migrateToLocale: { ...ok, count: 3 } } },
    },
  };

  it('lists only installed locales by default', async () => {
    // Wiki.js otherwise lists every locale it could download — over a hundred.
    stubFetch(routes);
    const { json, close } = await connect();
    const out = (await json('list_locales', {})) as {
      shown: number;
      total: number;
    };
    expect(out.shown).toBe(1);
    expect(out.total).toBe(2);
    await close();
  });

  it('reads navigation, engines and API keys', async () => {
    stubFetch(routes);
    const { json, close } = await connect();
    expect(
      (await json('get_navigation_tree')) as { config: unknown }
    ).toHaveProperty('config');
    expect(
      (await json('list_search_engines')) as { note: string }
    ).toHaveProperty('note');
    expect(
      (await json('list_api_keys')) as { apiEnabled: boolean }
    ).toMatchObject({
      apiEnabled: true,
    });
    await close();
  });

  it('re-renders one page without asking, because nothing can be lost', async () => {
    stubFetch(routes);
    const { text, close } = await connect();
    expect(await text('render_page', { page_id: 7 })).toContain(
      'Re-rendered page 7'
    );
    await close();
  });

  it('gates the one maintenance operation that loses something', async () => {
    stubFetch(routes);
    const { confirmed, close } = await connect();
    expect(
      await confirmed('purge_page_history', { older_than: 'P1Y' })
    ).toContain('Purged page versions');
    await close();
  });

  it('runs the three that only cost time without asking anyone', async () => {
    // They used to be gated on the grounds that they are instance-wide and
    // slow. Nothing is lost by any of them — the argument was about cost, not
    // content — and a dialog in front of an operation that loses nothing is
    // how people learn to tick without reading, which spends exactly the
    // attention purge_page_history needs.
    stubFetch(routes);
    const { text, close } = await connect();
    expect(await text('flush_page_cache', {})).toContain('Flushed');
    expect(await text('rebuild_page_tree', {})).toContain(
      'Rebuilt the page tree'
    );
    expect(await text('rebuild_search_index', {})).toContain(
      'Rebuilt the search index'
    );
    await close();
  });

  it('takes no confirm_token on the three, so a stale caller is told', async () => {
    // Not merely unguarded: the parameter is gone from the schema, so a caller
    // that still sends one gets a schema error rather than silence.
    stubFetch(routes);
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    for (const name of [
      'flush_page_cache',
      'rebuild_page_tree',
      'rebuild_search_index',
    ]) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      const properties = (
        tool!.inputSchema as { properties?: Record<string, unknown> }
      ).properties;
      expect(properties && 'confirm_token' in properties, name).toBe(false);
    }
    await close();
  });

  it('refuses a locale migration to the same locale', async () => {
    stubFetch(routes);
    const { call, close } = await connect();
    const result = await call('migrate_pages_locale', {
      source_locale: 'en',
      target_locale: 'en',
    });
    expect(result.isError).toBe(true);
    await close();
  });

  it('will not run a locale migration in the opposite direction on the same token', async () => {
    // Same pair of locales, opposite operation.
    stubFetch(routes);
    const { text, call, close } = await connect();
    const prompt = await text('migrate_pages_locale', {
      source_locale: 'de',
      target_locale: 'en',
    });
    const token = /confirm_token="([0-9a-f]{32})"/.exec(prompt)?.[1];
    const reversed = await call('migrate_pages_locale', {
      source_locale: 'en',
      target_locale: 'de',
      confirm_token: token,
    });
    expect(reversed.isError).toBe(true);
    await close();
  });

  it('reports how many pages a migration moved', async () => {
    stubFetch(routes);
    const { confirmed, close } = await connect();
    const out = await confirmed('migrate_pages_locale', {
      source_locale: 'de',
      target_locale: 'en',
    });
    expect(out).toContain('"movedPages": 3');
    await close();
  });

  it('gates the two tools that can lock the server out of the wiki', async () => {
    stubFetch(routes);
    const { confirmed, close } = await connect();
    expect(await confirmed('revoke_api_key', { key_id: 1 })).toContain(
      'Revoked API key 1'
    );
    expect(await confirmed('set_api_state', { enabled: false })).toContain(
      'now disabled'
    );
    await close();
  });

  it('has no tool that can mint an API key', async () => {
    // Wiki.js can do it over GraphQL, and a model that could would be able to
    // grant itself durable administrative access to the wiki.
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('create_api_key');
    await close();
  });
});
