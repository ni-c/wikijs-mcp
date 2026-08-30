import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertSucceeded } from '../api.js';
import { identifier } from '../confirm.js';
import * as gql from '../gql/pages.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { budgetedList, run, textResult } from '../result.js';
import { confirmTokenParam, idParam, tagParam, titleParam } from '../schema.js';
import type { ToolContext } from './context.js';

export function registerTagTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_tags',
    {
      title: 'List all tags',
      description:
        'Every tag in the wiki, with its display title and when it was last ' +
        'used. Tags are the one cross-cutting index a wiki has, so this is ' +
        'often a better starting point than search — feed a tag back into ' +
        'list_pages to see what carries it.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        const data = await api.execute('list_tags', gql.LIST_TAGS);
        const tags = listOf(
          objectOf(data.pages, 'the page query').tags,
          'tags'
        );
        return budgetedList('tags', tags, {
          untrusted: true,
          extra: { count: tags.length },
        });
      })
  );

  server.registerTool(
    'search_tags',
    {
      title: 'Search tags',
      description:
        'Finds tags matching a fragment. Cheaper than list_tags on a wiki with ' +
        'hundreds of them, and the usual way to check what a tag is actually ' +
        'called before filtering list_pages by it.',
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe('Fragment to match against tag names.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) =>
      run(async () => {
        const data = await api.execute('search_tags', gql.SEARCH_TAGS, {
          query,
        });
        const tags = listOf(
          objectOf(data.pages, 'the page query').searchTags,
          'tags'
        );
        return budgetedList('tags', tags, {
          untrusted: true,
          extra: { count: tags.length },
        });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'update_tag',
    {
      title: 'Rename a tag',
      description:
        'Changes a tag’s name or display title across every page carrying it. ' +
        'Renaming affects all of them at once, which is the point and also the ' +
        'risk, so it needs a confirmation token.',
      inputSchema: {
        tag_id: idParam.describe('Tag id from list_tags.'),
        tag: tagParam.describe('New tag name.'),
        title: titleParam.describe('New display title.'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({ tag_id, tag, title, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'update_tag',
            targets: [`tag:${tag_id}`, `name:${tag}`],
            what: `rename tag ${tag_id} to ${identifier(tag, 'tag')}`,
            consequence: 'Every page carrying this tag is affected at once.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('update_tag', gql.UPDATE_TAG, {
              id: tag_id,
              tag,
              title,
            });
            assertSucceeded(
              objectOf(data.pages, 'the page mutation').updateTag,
              'update_tag'
            );
            return textResult(`Renamed tag ${tag_id} to "${tag}".`);
          }
        )
      )
  );

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete a tag',
      description:
        'Removes a tag from the wiki and from every page that carries it. The ' +
        'pages themselves are untouched. Requires a confirmation token.',
      inputSchema: {
        tag_id: idParam.describe('Tag id from list_tags.'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ tag_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_tag',
            targets: [String(tag_id)],
            what: `delete tag ${tag_id}`,
            consequence:
              'The tag is removed from every page carrying it. The pages stay.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('delete_tag', gql.DELETE_TAG, {
              id: tag_id,
            });
            assertSucceeded(
              objectOf(data.pages, 'the page mutation').deleteTag,
              'delete_tag'
            );
            return textResult(`Deleted tag ${tag_id}.`);
          }
        )
      )
  );
}
