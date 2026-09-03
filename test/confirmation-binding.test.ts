import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, stubFetch, tokenOf, type Routes } from './harness.js';

/**
 * Every gated tool, every argument: change one, and the token must break.
 *
 * The findings this file exists for were all the same shape — `update_group`
 * sending five arguments and binding three, `create_user` sending seven and
 * binding two — and all of them were found by reading. A test per finding would
 * have caught each one after somebody noticed it; this catches the next one
 * before anybody does.
 *
 * The property, stated once: a confirmation token authorises the call it was
 * shown for. So for each gated tool, take a baseline, obtain a token, and
 * replay it with exactly one argument different. The token must be refused —
 * for every argument except `confirm_token` itself.
 *
 * Two things keep it from being a test that cannot fail. The positive control
 * below proves the unchanged baseline *is* accepted, so a refusal always means
 * the binding and never a broken stub. And the table is checked against the
 * tools' own input schemas, so an argument added later and forgotten here fails
 * the run rather than passing silently — which is how the original two got in.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ok = {
  responseResult: { succeeded: true, errorCode: 0, slug: 'ok', message: 'ok' },
};

/**
 * Enough of Wiki.js for the guard to be reached and, on the control, passed.
 *
 * Page lookups answer for whatever id they were asked about, because varying
 * `page_id` is one of the variations and a stub pinned to one id would make
 * that case fail for the wrong reason.
 */
const routes: Routes = {
  'query GetPageMetadata': ({ variables }) => ({
    data: {
      pages: {
        single: {
          id: variables.id,
          path: `docs/page-${String(variables.id)}`,
          locale: 'en',
          title: 'T',
          editor: 'markdown',
        },
      },
    },
  }),
  'query SearchUsers': { data: { users: { search: [] } } },
  'mutation UpdateComment': { data: { comments: { update: ok } } },
  'mutation DeleteComment': { data: { comments: { delete: ok } } },
  'mutation UpdateGroup': { data: { groups: { update: ok } } },
  'mutation DeleteGroup': { data: { groups: { delete: ok } } },
  'mutation AssignUser': { data: { groups: { assignUser: ok } } },
  'mutation UnassignUser': { data: { groups: { unassignUser: ok } } },
  'mutation CreateUser': { data: { users: { create: ok } } },
  'mutation UpdateUser': { data: { users: { update: ok } } },
  'mutation DeleteUser': { data: { users: { delete: ok } } },
  'mutation ActivateUser': { data: { users: { activate: ok } } },
  'mutation VerifyUser': { data: { users: { verify: ok } } },
  'mutation EnableTfa': { data: { users: { enableTFA: ok } } },
  'mutation ResetPassword': { data: { users: { resetPassword: ok } } },
  'mutation RestoreVersion': { data: { pages: { restore: ok } } },
  'mutation MovePage': { data: { pages: { move: ok } } },
  'mutation DeletePage': { data: { pages: { delete: ok } } },
  'mutation ConvertPage': { data: { pages: { convert: ok } } },
  'mutation PurgeHistory': { data: { pages: { purgeHistory: ok } } },
  'mutation MigrateLocale': {
    data: { pages: { migrateToLocale: { ...ok, count: 1 } } },
  },
  'mutation UpdateTag': { data: { pages: { updateTag: ok } } },
  'mutation DeleteTag': { data: { pages: { deleteTag: ok } } },
  'mutation RenameAsset': { data: { assets: { renameAsset: ok } } },
  'mutation DeleteAsset': { data: { assets: { deleteAsset: ok } } },
  'mutation RevokeApiKey': {
    data: { authentication: { revokeApiKey: ok } },
  },
  'mutation SetApiState': { data: { authentication: { setApiState: ok } } },
};

interface GatedCase {
  /** A call that is expected to succeed once confirmed. */
  base: Record<string, unknown>;
  /** A different value for each argument in `base`. */
  vary: Record<string, unknown>;
  /**
   * Arguments that choose the target rather than decide the outcome, with the
   * reason. Written out rather than listed, so an argument cannot leave the
   * sweep by being quietly added to an array.
   */
  excused?: Record<string, string>;
}

const pageAlternatives = {
  path: 'an alternative way of naming the page page_id already names; the resolved id is what the key binds',
  locale: 'only read when the page is named by path rather than by id',
};

const CASES: Record<string, GatedCase> = {
  update_comment: {
    base: { comment_id: 4, content: 'the original text' },
    vary: { comment_id: 5, content: 'something else entirely' },
  },
  delete_comment: {
    base: { comment_id: 4 },
    vary: { comment_id: 5 },
  },
  update_group: {
    base: {
      group_id: 1,
      name: 'Editors',
      permissions: ['read:pages'],
      page_rules: [],
      redirect_on_login: '/',
    },
    vary: {
      group_id: 2,
      // The finding itself: a group renamed to this impersonates the real one
      // in every administration view and in every later list_groups answer.
      name: 'Administrators',
      permissions: ['manage:system'],
      page_rules: [
        {
          id: 'r1',
          deny: false,
          match: 'START',
          roles: ['read:pages'],
          path: 'docs',
          locales: [],
        },
      ],
      // Where Wiki.js sends a member *after* it has authenticated them.
      redirect_on_login: 'https://wiki-login.example.invalid/',
    },
  },
  delete_group: { base: { group_id: 1 }, vary: { group_id: 2 } },
  assign_user_to_group: {
    base: { group_id: 1, user_id: 2 },
    vary: { group_id: 3, user_id: 4 },
  },
  unassign_user_from_group: {
    base: { group_id: 1, user_id: 2 },
    vary: { group_id: 3, user_id: 4 },
  },
  create_user: {
    base: {
      email: 'new@example.test',
      name: 'New Person',
      password: 'a-long-enough-password',
      provider_key: 'local',
      groups: [],
      must_change_password: false,
      send_welcome_email: false,
    },
    vary: {
      email: 'other@example.test',
      name: 'Other Person',
      password: 'a-different-long-password',
      provider_key: 'ldap',
      groups: [1],
      must_change_password: true,
      send_welcome_email: true,
    },
  },
  update_user: {
    base: {
      user_id: 1,
      email: 'a@example.test',
      name: 'A',
      groups: [1],
      location: 'Luxembourg',
      job_title: 'Tester',
    },
    vary: {
      user_id: 2,
      email: 'attacker@example.test',
      name: 'B',
      groups: [2],
      location: 'Elsewhere',
      job_title: 'Auditor',
    },
  },
  delete_user: {
    base: { user_id: 1, replace_with_user_id: 2 },
    vary: { user_id: 3, replace_with_user_id: 4 },
  },
  set_user_active: {
    base: { user_id: 1, active: true },
    vary: { user_id: 2, active: false },
  },
  verify_user: { base: { user_id: 1 }, vary: { user_id: 2 } },
  set_user_tfa: {
    base: { user_id: 1, enabled: true },
    vary: { user_id: 2, enabled: false },
  },
  reset_user_password: { base: { user_id: 1 }, vary: { user_id: 2 } },
  restore_page_version: {
    base: { page_id: 7, version_id: 30 },
    vary: { page_id: 8, version_id: 31 },
  },
  move_page: {
    base: {
      page_id: 7,
      destination_path: 'docs/new',
      destination_locale: 'en',
    },
    vary: {
      page_id: 8,
      destination_path: 'docs/somewhere-else',
      destination_locale: 'de',
    },
    excused: pageAlternatives,
  },
  delete_page: {
    base: { page_id: 7 },
    vary: { page_id: 8 },
    excused: pageAlternatives,
  },
  convert_page_editor: {
    base: { page_id: 7, editor: 'markdown' },
    vary: { page_id: 8, editor: 'code' },
    excused: pageAlternatives,
  },
  purge_page_history: {
    base: { older_than: 'P1Y' },
    vary: { older_than: 'P1D' },
  },
  migrate_pages_locale: {
    base: { source_locale: 'de', target_locale: 'en' },
    vary: { source_locale: 'fr', target_locale: 'es' },
  },
  update_tag: {
    base: { tag_id: 1, tag: 'docs', title: 'Documentation' },
    vary: { tag_id: 2, tag: 'guides', title: 'Something else entirely' },
  },
  delete_tag: { base: { tag_id: 1 }, vary: { tag_id: 2 } },
  rename_asset: {
    base: { asset_id: 1, filename: 'diagram.png' },
    vary: { asset_id: 2, filename: 'other.png' },
  },
  delete_asset: { base: { asset_id: 1 }, vary: { asset_id: 2 } },
  revoke_api_key: { base: { key_id: 1 }, vary: { key_id: 2 } },
  set_api_state: { base: { enabled: true }, vary: { enabled: false } },
};

/** The tools that answer an unconfirmed call with a token. */
async function gatedToolNames(): Promise<string[]> {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  await close();
  return tools
    .filter((tool) => {
      // The values are never read, only tested for presence — but `void` is
      // not a type the schema's property values can be converted to, and
      // saying `unknown` costs nothing here.
      const schema = tool.inputSchema as {
        properties?: Record<string, unknown>;
      };
      return schema.properties?.confirm_token !== undefined;
    })
    .map((tool) => tool.name);
}

describe('the sweep knows which tools and arguments it is sweeping', () => {
  it('covers every gated tool the server registers', async () => {
    // Not a hand-counted number: the server's own tool list decides. A new
    // guarded tool arrives here as a failure rather than as an omission.
    expect(new Set(await gatedToolNames())).toEqual(
      new Set(Object.keys(CASES))
    );
  });

  it('covers every argument of every gated tool', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    await close();

    for (const [name, testCase] of Object.entries(CASES)) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `${name} is in the sweep but not registered`).toBeDefined();
      const schema = tool?.inputSchema as
        { properties?: Record<string, unknown> } | undefined;
      const declared = new Set(Object.keys(schema?.properties ?? {}));
      declared.delete('confirm_token');
      const accounted = new Set([
        ...Object.keys(testCase.base),
        ...Object.keys(testCase.excused ?? {}),
      ]);
      expect(accounted, `${name}: arguments not swept and not excused`).toEqual(
        declared
      );
      expect(
        Object.keys(testCase.vary).sort(),
        `${name}: every argument in base needs a different value`
      ).toEqual(Object.keys(testCase.base).sort());
    }
  });
});

describe('a confirmation token authorises the call it was shown for', () => {
  it('accepts the baseline it was issued for — the control', async () => {
    // Without this the sweep below proves nothing: every call erroring for an
    // unrelated reason would look exactly like a perfectly bound token.
    stubFetch(routes);
    const { text, call, close } = await connect();
    for (const [name, testCase] of Object.entries(CASES)) {
      const first = await text(name, testCase.base);
      const confirmed = await call(name, {
        ...testCase.base,
        confirm_token: tokenOf(first),
      });
      expect(
        confirmed.isError,
        `${name}: the unchanged baseline was refused`
      ).toBeFalsy();
    }
    await close();
  });

  for (const [name, testCase] of Object.entries(CASES)) {
    for (const argument of Object.keys(testCase.base)) {
      it(`${name}: refuses it once ${argument} changed`, async () => {
        stubFetch(routes);
        const { text, call, close } = await connect();
        const first = await text(name, testCase.base);
        const replayed = await call(name, {
          ...testCase.base,
          [argument]: testCase.vary[argument],
          confirm_token: tokenOf(first),
        });
        expect(
          replayed.isError,
          `${name} executed with a different ${argument} than it was confirmed for`
        ).toBe(true);
        await close();
      });
    }
  }
});
