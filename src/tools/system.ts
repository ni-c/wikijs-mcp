import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertSucceeded } from '../api.js';
import * as gql from '../gql/admin.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import { confirmTokenParam, idParam } from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * Instance-level tools.
 *
 * Note what is missing: there is no `create_api_key`. Wiki.js can mint a
 * full-access key over GraphQL, and a tool that does so would let a model grant
 * itself durable administrative access to the wiki — the one capability worth
 * refusing outright, because it survives the session, the server and any later
 * tightening of this configuration. `list_api_keys` and `revoke_api_key` are
 * here, so keys can be audited and taken away; minting one stays a job for a
 * human in the admin UI.
 */
export function registerSystemTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'get_site_info',
    {
      title: 'Get site and system information',
      description:
        'Version, database, host summary and the site’s own title and ' +
        'description, plus totals for pages, users, groups and tags. The first ' +
        'call to make when something is not behaving — it proves the URL and ' +
        'the API key work at all. Fields describing the host filesystem and ' +
        'database host are deliberately not requested.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.execute('get_site_info', gql.SITE_INFO);
        const site = objectOf(data.site, 'the site query');
        const system = objectOf(data.system, 'the system query');
        return jsonResult({
          site: site.config,
          system: system.info,
        });
      })
  );

  server.registerTool(
    'list_locales',
    {
      title: 'List locales',
      description:
        'Which locales are installed and which one is the default. Worth ' +
        'checking once per wiki: the locale is part of a page’s identity, and ' +
        'every page tool here falls back to WIKIJS_LOCALE, so a wiki running on ' +
        '"de" needs that set or nothing will be found.',
      inputSchema: {
        installed_only: z
          .boolean()
          .optional()
          .describe(
            'Only locales actually installed (default true). Wiki.js lists ' +
              'every locale it could download otherwise — over a hundred.'
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ installed_only }) =>
      run(async () => {
        const data = await api.execute('list_locales', gql.LIST_LOCALES);
        const localization = objectOf(
          data.localization,
          'the localization query'
        );
        const all = listOf(localization.locales, 'locales') as Array<{
          isInstalled?: boolean;
        }>;
        const shown =
          installed_only === false
            ? all
            : all.filter((locale) => locale.isInstalled === true);
        return budgetedList('locales', shown, {
          extra: {
            config: localization.config,
            shown: shown.length,
            total: all.length,
            serverDefault: api.defaultLocale,
          },
        });
      })
  );

  server.registerTool(
    'get_navigation_tree',
    {
      title: 'Get the navigation menu',
      description:
        'The sidebar navigation as configured, per locale. This is curated by ' +
        'hand and is not the page tree — get_page_tree is what reflects the ' +
        'pages that actually exist.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.execute(
          'get_navigation_tree',
          gql.NAVIGATION_TREE
        );
        const navigation = objectOf(data.navigation, 'the navigation query');
        return jsonResult({
          config: navigation.config,
          tree: navigation.tree,
        });
      })
  );

  server.registerTool(
    'list_search_engines',
    {
      title: 'List search engines',
      description:
        'Which search engine this wiki uses. Worth knowing before trusting ' +
        'search_pages: the default "Database - Basic" indexes only titles and ' +
        'descriptions, so nothing written inside a page is searchable until a ' +
        'real engine is configured and the index rebuilt.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.execute(
          'list_search_engines',
          gql.LIST_SEARCH_ENGINES
        );
        const engines = listOf(
          objectOf(data.search, 'the search query').searchEngines,
          'search engines'
        );
        return budgetedList('engines', engines, {
          extra: {
            note:
              'Only the engine with isEnabled=true is in use. "db" is ' +
              '"Database - Basic" and does not index page content.',
          },
        });
      })
  );

  server.registerTool(
    'list_api_keys',
    {
      title: 'List API keys',
      description:
        'Lists the wiki’s API keys with their expiry and whether they are ' +
        'revoked, plus whether API access is switched on at all. Wiki.js stores ' +
        'only a truncated form of each key and never returns the secret, so ' +
        'nothing here can be used to authenticate.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.execute('list_api_keys', gql.LIST_API_KEYS);
        const auth = objectOf(data.authentication, 'the authentication query');
        const keys = listOf(auth.apiKeys, 'API keys');
        return budgetedList('apiKeys', keys, {
          extra: { apiEnabled: auth.apiState, count: keys.length },
        });
      })
  );

  server.registerTool(
    'list_storage_targets',
    {
      title: 'List storage targets',
      description:
        'The configured storage backends — git mirrors, S3 buckets, local ' +
        'file dumps — with their sync status and last error. Credentials in ' +
        'their configuration are redacted.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.execute(
          'list_storage_targets',
          gql.LIST_STORAGE_TARGETS
        );
        const storage = objectOf(data.storage, 'the storage query');
        const targets = listOf(storage.targets, 'storage targets');
        return budgetedList('targets', targets, {
          extra: { status: storage.status },
        });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'revoke_api_key',
    {
      title: 'Revoke an API key',
      description:
        'Revokes an API key immediately and for good — Wiki.js has no way to ' +
        'un-revoke one. Note that this can revoke the key this server is using, ' +
        'which would cut its own connection. Requires a confirmation token.',
      inputSchema: {
        key_id: idParam.describe('Key id from list_api_keys.'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ key_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'revoke_api_key',
            targets: [String(key_id)],
            what: `revoke API key ${key_id}`,
            consequence:
              'Anything using that key stops working at once, possibly including this server. Revocation cannot be undone.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'revoke_api_key',
              gql.REVOKE_API_KEY,
              { id: key_id }
            );
            assertSucceeded(
              objectOf(data.authentication, 'the authentication mutation')
                .revokeApiKey,
              'revoke_api_key'
            );
            return textResult(`Revoked API key ${key_id}.`);
          }
        )
      )
  );

  server.registerTool(
    'set_api_state',
    {
      title: 'Turn the API on or off',
      description:
        'Switches Wiki.js’ whole API on or off. Turning it off disables every ' +
        'API key at once, including this server’s — after which the only way ' +
        'back is the web administration UI. Requires a confirmation token.',
      inputSchema: {
        enabled: z
          .boolean()
          .describe('True to enable the API, false to disable it.'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ enabled, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'set_api_state',
            targets: [String(enabled)],
            what: `turn the Wiki.js API ${enabled ? 'on' : 'off'}`,
            consequence: enabled
              ? 'All non-revoked API keys start working again.'
              : 'Every API key stops working, including this server’s — only the web UI can turn it back on.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('set_api_state', gql.SET_API_STATE, {
              enabled,
            });
            assertSucceeded(
              objectOf(data.authentication, 'the authentication mutation')
                .setApiState,
              'set_api_state'
            );
            return textResult(
              `The Wiki.js API is now ${enabled ? 'enabled' : 'disabled'}.`
            );
          }
        )
      )
  );
}
