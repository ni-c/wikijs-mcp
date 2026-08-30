import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertSucceeded } from '../api.js';
import { identifier } from '../confirm.js';
import * as adminGql from '../gql/admin.js';
import * as gql from '../gql/pages.js';
import { guarded } from '../guard.js';
import { objectOf } from '../normalize.js';
import { PathScopeError, type PathScope } from '../paths.js';
import { jsonResult, run, textResult } from '../result.js';
import { confirmTokenParam, idParam, localeParam } from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * The retention cutoff for `purge_page_history`.
 *
 * Wiki.js parses this with Luxon as an ISO-8601 duration and its own admin UI
 * offers a fixed list. A duration it cannot parse is accepted by the API and
 * then silently matches nothing, so the choices are spelled out here rather
 * than left as free text.
 */
const olderThanParam = z
  .enum(['P1D', 'P1M', 'P3M', 'P6M', 'P1Y', 'P2Y', 'P3Y'])
  .describe(
    'ISO-8601 duration cutoff, as Wiki.js’ own admin UI offers: P1D (a day), ' +
      'P1M, P3M, P6M, P1Y, P2Y, P3Y. Versions older than this are deleted.'
  );

/**
 * Instance-wide maintenance.
 *
 * These are all cheap to call and expensive to get wrong: they act on the whole
 * wiki rather than one page, and several take minutes on a large instance while
 * the API keeps answering. All of them are gated except `render_page`, which
 * affects exactly one page and cannot lose anything.
 */
/**
 * Refuses an operation that acts on the whole wiki while writes are confined.
 *
 * These cannot be expressed as a path prefix — `migrate_pages_locale` moves
 * every page there is — so there is no way to honour the scope and no honest
 * way to run them anyway. An operator who set WIKIJS_ALLOWED_PATHS was told
 * nothing outside it can be written; this keeps that true instead of quietly
 * making it an exception.
 */
function refuseWhenScoped(scope: PathScope, tool: string): void {
  if (!scope.active) return;
  throw new PathScopeError(
    `${tool} acts on every page in the wiki and cannot be confined to ` +
      `WIKIJS_ALLOWED_PATHS (${scope.prefixes.join(', ')}). Unset it to run this.`
  );
}

export function registerMaintenanceTools(
  server: McpServer,
  { api, confirmations, scope, readOnly }: ToolContext
): void {
  if (readOnly) return;

  server.registerTool(
    'render_page',
    {
      title: 'Re-render a page',
      description:
        'Forces Wiki.js to regenerate one page’s HTML from its source. The fix ' +
        'for a page whose rendering is stale after a theme or renderer change. ' +
        'Changes no content and cannot lose anything.',
      inputSchema: { page_id: idParam },
      annotations: { idempotentHint: true },
    },
    async ({ page_id }) =>
      run(async () => {
        const data = await api.execute('render_page', gql.RENDER_PAGE, {
          id: page_id,
        });
        assertSucceeded(
          objectOf(data.pages, 'the page mutation').render,
          'render_page'
        );
        return textResult(`Re-rendered page ${page_id}.`);
      })
  );

  server.registerTool(
    'flush_page_cache',
    {
      title: 'Flush the page cache',
      description:
        'Drops Wiki.js’ rendered-page cache for the whole wiki. Nothing is ' +
        'lost, but every page has to be rendered again on first access, so a ' +
        'busy instance gets slower for a while. Requires a confirmation token.',
      inputSchema: { confirm_token: confirmTokenParam.optional() },
      annotations: { idempotentHint: false },
    },
    async ({ confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'flush_page_cache',
            targets: ['instance'],
            what: 'flush the rendered-page cache of the entire wiki',
            consequence:
              'No content is lost, but every page is rendered from scratch on next access.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('flush_page_cache', gql.FLUSH_CACHE);
            assertSucceeded(
              objectOf(data.pages, 'the page mutation').flushCache,
              'flush_page_cache'
            );
            return textResult('Flushed the page cache.');
          }
        )
      )
  );

  server.registerTool(
    'rebuild_page_tree',
    {
      title: 'Rebuild the page tree',
      description:
        'Recomputes the folder structure Wiki.js derives from page paths. The ' +
        'repair for a navigation tree that disagrees with the pages actually ' +
        'present, usually after a bulk import or a database edit. Requires a ' +
        'confirmation token.',
      inputSchema: { confirm_token: confirmTokenParam.optional() },
      annotations: { idempotentHint: false },
    },
    async ({ confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'rebuild_page_tree',
            targets: ['instance'],
            what: 'rebuild the page tree of the entire wiki',
            consequence:
              'Page content is untouched, but the operation walks every page and can take minutes.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'rebuild_page_tree',
              gql.REBUILD_TREE
            );
            assertSucceeded(
              objectOf(data.pages, 'the page mutation').rebuildTree,
              'rebuild_page_tree'
            );
            return textResult('Rebuilt the page tree.');
          }
        )
      )
  );

  server.registerTool(
    'rebuild_search_index',
    {
      title: 'Rebuild the search index',
      description:
        'Reindexes every page in the active search engine. Required once after ' +
        'switching away from "Database - Basic", because the new engine starts ' +
        'empty and search silently returns nothing until this runs. On the ' +
        'basic engine it does nothing. Requires a confirmation token.',
      inputSchema: { confirm_token: confirmTokenParam.optional() },
      annotations: { idempotentHint: false },
    },
    async ({ confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'rebuild_search_index',
            targets: ['instance'],
            what: 'rebuild the search index over every page in the wiki',
            consequence:
              'Search results may be incomplete while it runs, and it can take minutes on a large wiki.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'rebuild_search_index',
              adminGql.REBUILD_SEARCH_INDEX
            );
            assertSucceeded(
              objectOf(data.search, 'the search mutation').rebuildIndex,
              'rebuild_search_index'
            );
            return textResult('Rebuilt the search index.');
          }
        )
      )
  );

  server.registerTool(
    'purge_page_history',
    {
      title: 'Purge old page versions',
      description:
        'Deletes stored page versions older than a cutoff, across the whole ' +
        'wiki. The versions are gone permanently — this is the one maintenance ' +
        'operation that destroys data. Requires a confirmation token.',
      inputSchema: {
        older_than: olderThanParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ older_than, confirm_token }) =>
      run(async () => {
        refuseWhenScoped(scope, 'purge_page_history');
        return guarded(
          confirmations,
          {
            tool: 'purge_page_history',
            targets: [older_than],
            what: `purge every stored page version older than ${identifier(older_than, 'retention period')}`,
            consequence:
              'Those versions are deleted permanently across the whole wiki and cannot be restored.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'purge_page_history',
              gql.PURGE_HISTORY,
              { olderThan: older_than }
            );
            assertSucceeded(
              objectOf(data.pages, 'the page mutation').purgeHistory,
              'purge_page_history'
            );
            return textResult(`Purged page versions older than ${older_than}.`);
          }
        );
      })
  );

  server.registerTool(
    'migrate_pages_locale',
    {
      title: 'Move every page to another locale',
      description:
        'Moves all pages from one locale to another, across the whole wiki. ' +
        'The usual reason is a wiki set up under the wrong locale code. Every ' +
        'page path changes, so every external link into the wiki breaks. ' +
        'Requires a confirmation token.',
      inputSchema: {
        source_locale: localeParam.describe('Locale to move pages out of.'),
        target_locale: localeParam.describe('Locale to move pages into.'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ source_locale, target_locale, confirm_token }) =>
      run(async () => {
        refuseWhenScoped(scope, 'migrate_pages_locale');
        if (source_locale === target_locale) {
          throw new Error(
            'source_locale and target_locale are the same — there is nothing to move.'
          );
        }
        return guarded(
          confirmations,
          {
            // Labelled, not just listed. setResourceKey sorts its targets so
            // that a confirmation is bound to a set rather than to an argument
            // order — which is right for an unordered set and wrong here: a
            // bare [source, target] makes de→en and en→de the same key, so a
            // token for one would execute the other, moving every page the
            // wrong way. The role prefixes survive the sort.
            targets: [`from:${source_locale}`, `to:${target_locale}`],
            tool: 'migrate_pages_locale',
            what: `move every page from locale ${identifier(source_locale, 'locale')} to ${identifier(target_locale, 'locale')}`,
            consequence:
              'Every affected page changes its path, so links from outside the wiki break.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'migrate_pages_locale',
              gql.MIGRATE_LOCALE,
              { sourceLocale: source_locale, targetLocale: target_locale }
            );
            const mutation = objectOf(data.pages, 'the page mutation');
            assertSucceeded(mutation.migrateToLocale, 'migrate_pages_locale');
            return jsonResult({
              movedPages: (mutation.migrateToLocale as { count?: unknown })
                .count,
              from: source_locale,
              to: target_locale,
            });
          }
        );
      })
  );
}
