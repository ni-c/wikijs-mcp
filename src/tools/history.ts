import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  budgetedList,
  budgetedUntrustedResult,
  run,
  textResult,
} from '../result.js';
import {
  confirmTokenParam,
  idParam,
  localeParam,
  pagePathParam,
} from '../schema.js';

import { assertSucceeded, type WikiJsApi } from '../api.js';
import { unifiedDiff } from '../diff.js';
import * as gql from '../gql/pages.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { assertWithinScope } from '../paths.js';
import type { ToolContext } from './context.js';

/**
 * Resolves a page id from an id or a path.
 *
 * Duplicated deliberately from `pages.ts` rather than exported across modules:
 * it is six lines, and a shared helper here would be the first step towards a
 * page-resolution layer that every module imports and nobody owns.
 */
async function resolveId(
  api: WikiJsApi,
  args: {
    page_id?: number | undefined;
    path?: string | undefined;
    locale?: string | undefined;
  }
): Promise<Record<string, unknown>> {
  if (args.page_id !== undefined) {
    const data = await api.execute('get_page', gql.GET_PAGE_METADATA, {
      id: args.page_id,
    });
    return objectOf(
      objectOf(data.pages, 'the page query').single,
      `page ${args.page_id}`
    );
  }
  if (args.path === undefined) {
    throw new Error('either page_id or path is required.');
  }
  const locale = args.locale ?? api.defaultLocale;
  const data = await api.execute('get_page', gql.GET_PAGE_METADATA_BY_PATH, {
    path: args.path,
    locale,
  });
  return objectOf(
    objectOf(data.pages, 'the page query').singleByPath,
    `page "${args.path}" in locale "${locale}"`
  );
}

/** Fetches one stored version's body, for the diff tool. */
async function versionContent(
  api: WikiJsApi,
  pageId: number,
  versionId: number
): Promise<Record<string, unknown>> {
  const data = await api.execute('get_page_version', gql.PAGE_VERSION, {
    pageId,
    versionId,
  });
  return objectOf(
    objectOf(data.pages, 'the page query').version,
    `version ${versionId} of page ${pageId}`
  );
}

export function registerHistoryTools(
  server: McpServer,
  { api, confirmations, scope, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_page_history',
    {
      title: 'List a page’s history',
      description:
        'Lists the stored versions of a page, newest first, with who changed ' +
        'what and when. This is the one Wiki.js query that really paginates. ' +
        'The version ids here are what get_page_version, diff_page_versions and ' +
        'restore_page_version take.',
      inputSchema: z.object({
        page_id: idParam.optional(),
        path: pagePathParam.optional(),
        locale: localeParam.optional(),
        page: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Zero-based page of results (default 0).'),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Entries per page (default 50).'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, path, locale, page, page_size }) =>
      run(async () => {
        const target = await resolveId(api, { page_id, path, locale });
        const id = target.id as number;
        const data = await api.execute('list_page_history', gql.PAGE_HISTORY, {
          id,
          offsetPage: page ?? 0,
          offsetSize: page_size ?? 50,
        });
        const history = objectOf(
          objectOf(data.pages, 'the page query').history,
          'the page history'
        );
        const trail = listOf(history.trail, 'history entries');
        return budgetedList('versions', trail, {
          untrusted: true,
          extra: {
            pageId: id,
            path: target.path,
            total: history.total,
            page: page ?? 0,
          },
        });
      })
  );

  server.registerTool(
    'get_page_version',
    {
      title: 'Get one stored version',
      description:
        'Returns a single historical version of a page, including its full ' +
        'body as it was then. To find out what changed between two versions, ' +
        'diff_page_versions is far cheaper than reading both.',
      inputSchema: z.object({
        page_id: idParam,
        version_id: idParam.describe('Version id from list_page_history.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, version_id }) =>
      run(async () => {
        const version = await versionContent(api, page_id, version_id);
        return budgetedUntrustedResult({ version });
      })
  );

  server.registerTool(
    'diff_page_versions',
    {
      title: 'Compare two versions',
      description:
        'Returns a unified diff between two versions of a page — or between one ' +
        'version and the page as it is now, if to_version is omitted. Answers ' +
        '"what changed here" in one call instead of two full page bodies.',
      inputSchema: z.object({
        page_id: idParam,
        from_version: idParam.describe(
          'The older version id, from list_page_history.'
        ),
        to_version: idParam
          .optional()
          .describe(
            'The newer version id. Omit to compare against the live page.'
          ),
        context_lines: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe('Unchanged lines shown around each change (default 3).'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, from_version, to_version, context_lines }) =>
      run(async () => {
        const before = await versionContent(api, page_id, from_version);

        let after: { content: string; label: string };
        if (to_version === undefined) {
          const data = await api.execute(
            'diff_page_versions',
            gql.GET_PAGE_CONTENT,
            { id: page_id }
          );
          const live = objectOf(
            objectOf(data.pages, 'the page query').single,
            `page ${page_id}`
          );
          after = {
            content: typeof live.content === 'string' ? live.content : '',
            label: 'current',
          };
        } else {
          const version = await versionContent(api, page_id, to_version);
          after = {
            content: typeof version.content === 'string' ? version.content : '',
            label: String(to_version),
          };
        }

        const result = unifiedDiff(
          typeof before.content === 'string' ? before.content : '',
          after.content,
          context_lines ?? 3
        );

        return budgetedUntrustedResult({
          pageId: page_id,
          from: {
            versionId: from_version,
            versionDate: before.versionDate,
            authorName: before.authorName,
          },
          to: after.label,
          identical: result.identical,
          linesAdded: result.added,
          linesRemoved: result.removed,
          ...(result.note ? { note: result.note } : {}),
          diff: result.identical
            ? 'The two versions are identical.'
            : result.diff,
        });
      })
  );

  server.registerTool(
    'get_page_conflict',
    {
      title: 'Get the newer version behind a conflict',
      description:
        'Returns the version of a page that is newer than the one you read — ' +
        'what update_page points at when it refuses to write. Shows who saved ' +
        'it and when, so the change can be redone on top instead of discarded.',
      inputSchema: z.object({ page_id: idParam }),
      annotations: { readOnlyHint: true },
    },
    async ({ page_id }) =>
      run(async () => {
        const data = await api.execute(
          'get_page_conflict',
          gql.CONFLICT_LATEST,
          { id: page_id }
        );
        const conflict = objectOf(
          objectOf(data.pages, 'the page query').conflictLatest,
          `the conflict state of page ${page_id}`
        );
        return budgetedUntrustedResult({ conflict });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'restore_page_version',
    {
      title: 'Restore an earlier version',
      description:
        'Rolls a page back to a stored version. The current content is not ' +
        'lost — it becomes another entry in the history — but the live page is ' +
        'replaced. Requires a confirmation token.',
      inputSchema: z.object({
        page_id: idParam,
        version_id: idParam.describe('Version id from list_page_history.'),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ page_id, version_id, confirm_token }) =>
      run(async () => {
        const target = await resolveId(api, { page_id });
        assertWithinScope(scope, String(target.path), 'page path');

        return guarded(
          confirmations,
          {
            tool: 'restore_page_version',
            targets: [`page:${page_id}`, `version:${version_id}`],
            what: `restore page ${page_id} to version ${version_id}`,
            consequence:
              'The live page is replaced by that version; the current text moves into the history.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'restore_page_version',
              gql.RESTORE_VERSION,
              { pageId: page_id, versionId: version_id }
            );
            const pages = objectOf(data.pages, 'the page mutation');
            assertSucceeded(pages.restore, 'restore_page_version');
            return textResult(
              `Restored page ${page_id} to version ${version_id}.`
            );
          }
        );
      })
  );
}
