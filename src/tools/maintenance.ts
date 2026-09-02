import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { plain } from '../output-schema.js';

import { assertSucceeded } from '../api.js';
import { DESTRUCTIVE, WRITE_IDEMPOTENT } from './annotations.js';
import { identifier } from '../resource-key.js';
import * as adminGql from '../gql/admin.js';
import * as gql from '../gql/pages.js';
import { guarded } from '../guard.js';
import { objectOf } from '../normalize.js';
import { assertWithinScope, PathScopeError, type PathScope } from '../paths.js';
import { jsonResult, run, sentenceResult } from '../result.js';
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
 *
 * Gating and scoping are separate questions and answered separately here. The
 * three lossless instance-wide operations are deliberately *not* gated — a
 * dialog in front of something that loses nothing is how people learn to tick
 * without reading — but they are still refused under WIKIJS_ALLOWED_PATHS,
 * because that variable is a promise about reach rather than about damage, and
 * "every page in the wiki" is outside any prefix.
 */
/**
 * Refuses an operation that acts on the whole wiki while writes are confined.
 *
 * These cannot be expressed as a path prefix — `migrate_pages_locale` moves
 * every page there is — so there is no way to honour the scope and no honest
 * way to run them anyway. An operator who set WIKIJS_ALLOWED_PATHS was told
 * nothing outside it can be written; this keeps that true instead of quietly
 * making it an exception.
 *
 * Applied to every instance-wide operation, not only the destructive ones. The
 * lossless three cost the whole wiki minutes of slower rendering and incomplete
 * search, which is an effect outside the prefix even though nothing is deleted;
 * and a scope enforced on some members of a class is the sort of thing whose
 * documentation stays categorical long after the code stopped being.
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
  { api, approval, confirmations, scope, readOnly }: ToolContext
): void {
  if (readOnly) return;

  server.registerTool(
    'render_page',
    {
      title: 'Re-render a page',
      description:
        'Forces Wiki.js to regenerate one page’s HTML from its source. The fix ' +
        'for a page whose rendering is stale after a theme or renderer change. ' +
        'Changes no content and cannot lose anything.\n\n' +
        'It does, however, bump the page’s updatedAt — and update_page compares ' +
        'that against when you last read the page, to catch somebody else ' +
        'saving in between. So a render between your read and your write makes ' +
        'update_page refuse *your own* next write, saying the page changed ' +
        'after you read it. If that happens, call get_page again and then ' +
        'write; nothing was lost. Better still, render after writing rather ' +
        'than before.',
      inputSchema: z.object({ page_id: idParam }),
      annotations: WRITE_IDEMPOTENT,
      outputSchema: plain(),
    },
    async ({ page_id }) =>
      run(async () => {
        // The one page-writing tool that took a page id and never asked where
        // that page lives. It changes no content, but it rewrites the stored
        // HTML and bumps updatedAt — and update_page's conflict check reads
        // exactly that field, so an unscoped render is also a way to make
        // somebody else's next write outside the prefix fail. Only looked up
        // while a scope is set, the way create_comment does it, because the
        // extra round trip buys nothing when every path is allowed.
        if (scope.active) {
          const page = objectOf(
            objectOf(
              (
                await api.execute('render_page', gql.GET_PAGE_METADATA, {
                  id: page_id,
                })
              ).pages,
              'the page query'
            ).single,
            `page ${page_id}`
          );
          assertWithinScope(scope, String(page.path), 'page path');
        }
        const data = await api.execute('render_page', gql.RENDER_PAGE, {
          id: page_id,
        });
        assertSucceeded(
          objectOf(data.pages, 'the page mutation').render,
          'render_page'
        );
        return sentenceResult(`Re-rendered page ${page_id}.`, {
          page_id,
          rendered: true,
        });
      })
  );

  server.registerTool(
    'flush_page_cache',
    {
      title: 'Flush the page cache',
      description:
        'Drops Wiki.js’ rendered-page cache for the whole wiki. Nothing is ' +
        'lost, but every page has to be rendered again on first access, so a ' +
        'busy instance gets slower for a while.',
      inputSchema: z.object({}),
      // Not guarded, and the argument for guarding it was always the wrong
      // one: it costs time, not content. A dialog in front of an operation
      // that loses nothing is how people learn to tick without reading, which
      // spends exactly the attention purge_page_history needs.
      annotations: WRITE_IDEMPOTENT,
      outputSchema: plain(),
    },
    async () =>
      run(async () => {
        refuseWhenScoped(scope, 'flush_page_cache');
        const data = await api.execute('flush_page_cache', gql.FLUSH_CACHE);
        assertSucceeded(
          objectOf(data.pages, 'the page mutation').flushCache,
          'flush_page_cache'
        );
        return sentenceResult('Flushed the page cache.', { flushed: true });
      })
  );

  server.registerTool(
    'rebuild_page_tree',
    {
      title: 'Rebuild the page tree',
      description:
        'Recomputes the folder structure Wiki.js derives from page paths. The ' +
        'repair for a navigation tree that disagrees with the pages actually ' +
        'present, usually after a bulk import or a database edit. Page content ' +
        'is untouched, but it walks every page and can take minutes.',
      inputSchema: z.object({}),
      // Not guarded, and the argument for guarding it was always the wrong
      // one: it costs time, not content. A dialog in front of an operation
      // that loses nothing is how people learn to tick without reading, which
      // spends exactly the attention purge_page_history needs.
      annotations: WRITE_IDEMPOTENT,
      outputSchema: plain(),
    },
    async () =>
      run(async () => {
        refuseWhenScoped(scope, 'rebuild_page_tree');
        const data = await api.execute('rebuild_page_tree', gql.REBUILD_TREE);
        assertSucceeded(
          objectOf(data.pages, 'the page mutation').rebuildTree,
          'rebuild_page_tree'
        );
        return sentenceResult('Rebuilt the page tree.', {
          rebuilt: 'page-tree',
        });
      })
  );

  server.registerTool(
    'rebuild_search_index',
    {
      title: 'Rebuild the search index',
      description:
        'Reindexes every page in the active search engine. Required once after ' +
        'switching away from "Database - Basic", because the new engine starts ' +
        'empty and search silently returns nothing until this runs. On the ' +
        'basic engine it does nothing. Search results may be incomplete while ' +
        'it runs, and it can take minutes on a large wiki.',
      inputSchema: z.object({}),
      // Not guarded, and the argument for guarding it was always the wrong
      // one: it costs time, not content. A dialog in front of an operation
      // that loses nothing is how people learn to tick without reading, which
      // spends exactly the attention purge_page_history needs.
      annotations: WRITE_IDEMPOTENT,
      outputSchema: plain(),
    },
    async () =>
      run(async () => {
        refuseWhenScoped(scope, 'rebuild_search_index');
        const data = await api.execute(
          'rebuild_search_index',
          adminGql.REBUILD_SEARCH_INDEX
        );
        assertSucceeded(
          objectOf(data.search, 'the search mutation').rebuildIndex,
          'rebuild_search_index'
        );
        return sentenceResult('Rebuilt the search index.', {
          rebuilt: 'search-index',
        });
      })
  );

  server.registerTool(
    'purge_page_history',
    {
      title: 'Purge old page versions',
      description:
        'Deletes stored page versions older than a cutoff, across the whole ' +
        'wiki. The versions are gone permanently — this is the one maintenance ' +
        'operation that destroys data. Requires a confirmation token.',
      inputSchema: z.object({
        older_than: olderThanParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
      outputSchema: plain(),
    },
    async ({ older_than, confirm_token }, mcp) =>
      run(async () => {
        refuseWhenScoped(scope, 'purge_page_history');
        return guarded(
          server,
          mcp,
          approval,
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
            return sentenceResult(
              `Purged page versions older than ${older_than}.`,
              {
                purged_older_than: older_than,
              }
            );
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
      inputSchema: z.object({
        source_locale: localeParam.describe('Locale to move pages out of.'),
        target_locale: localeParam.describe('Locale to move pages into.'),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
      outputSchema: plain(),
    },
    async ({ source_locale, target_locale, confirm_token }, mcp) =>
      run(async () => {
        refuseWhenScoped(scope, 'migrate_pages_locale');
        if (source_locale === target_locale) {
          throw new Error(
            'source_locale and target_locale are the same — there is nothing to move.'
          );
        }
        return guarded(
          server,
          mcp,
          approval,
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
