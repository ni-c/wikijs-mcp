import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertSucceeded } from '../api.js';
import * as gql from '../gql/admin.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import {
  budgetedList,
  budgetedUntrustedResult,
  jsonResult,
  run,
  textResult,
} from '../result.js';
import {
  confirmTokenParam,
  idParam,
  localeParam,
  pagePathParam,
} from '../schema.js';
import type { ToolContext } from './context.js';

const commentBodyParam = z
  .string()
  .trim()
  .min(1, 'a comment cannot be empty')
  .max(50_000)
  .describe('Comment body, in markdown.');

export function registerCommentTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_comments',
    {
      title: 'List comments on a page',
      description:
        'Returns the comments on one page, addressed by path and locale — not ' +
        'by page id, which is the one place Wiki.js asks for the path instead. ' +
        'An empty list can also mean comments are switched off for the wiki; ' +
        'get_site_info reports that.',
      inputSchema: {
        path: pagePathParam,
        locale: localeParam.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ path, locale }) =>
      run(async () => {
        const data = await api.execute('list_comments', gql.LIST_COMMENTS, {
          path,
          locale: locale ?? api.defaultLocale,
        });
        const comments = listOf(
          objectOf(data.comments, 'the comment query').list,
          'comments'
        );
        return budgetedList('comments', comments, {
          untrusted: true,
          extra: { path, count: comments.length },
        });
      })
  );

  server.registerTool(
    'get_comment',
    {
      title: 'Get one comment',
      description:
        'Returns a single comment by id, with its source and its rendered HTML.',
      inputSchema: { comment_id: idParam },
      annotations: { readOnlyHint: true },
    },
    async ({ comment_id }) =>
      run(async () => {
        const data = await api.execute('get_comment', gql.GET_COMMENT, {
          id: comment_id,
        });
        const comment = objectOf(
          objectOf(data.comments, 'the comment query').single,
          `comment ${comment_id}`
        );
        return budgetedUntrustedResult({ comment });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'create_comment',
    {
      title: 'Post a comment',
      description:
        'Posts a comment on a page, optionally as a reply to another. The ' +
        'comment is attributed to the account the API key belongs to, which is ' +
        'usually a service account rather than a person — say so in the text if ' +
        'that matters.',
      inputSchema: {
        page_id: idParam.describe('Page id the comment belongs to.'),
        content: commentBodyParam,
        reply_to: idParam.optional().describe('Comment id this replies to.'),
      },
      annotations: { idempotentHint: false },
    },
    async ({ page_id, content, reply_to }) =>
      run(async () => {
        const data = await api.execute('create_comment', gql.CREATE_COMMENT, {
          pageId: page_id,
          content,
          // 0, not null. `replyTo` is nullable in the GraphQL schema but NOT
          // NULL in the database, so a top-level comment sent as null fails
          // with a raw Postgres constraint error leaking the whole INSERT
          // statement back to the caller.
          replyTo: reply_to ?? 0,
        });
        const mutation = objectOf(data.comments, 'the comment mutation');
        assertSucceeded(mutation.create, 'create_comment');
        return jsonResult({
          created: (mutation.create as { id?: unknown }).id,
          pageId: page_id,
        });
      })
  );

  server.registerTool(
    'update_comment',
    {
      title: 'Edit a comment',
      description:
        'Replaces the body of a comment. Wiki.js keeps no history for ' +
        'comments, so the previous text is gone.',
      inputSchema: {
        comment_id: idParam,
        content: commentBodyParam,
      },
      annotations: { idempotentHint: true },
    },
    async ({ comment_id, content }) =>
      run(async () => {
        const data = await api.execute('update_comment', gql.UPDATE_COMMENT, {
          id: comment_id,
          content,
        });
        assertSucceeded(
          objectOf(data.comments, 'the comment mutation').update,
          'update_comment'
        );
        return textResult(`Updated comment ${comment_id}.`);
      })
  );

  server.registerTool(
    'delete_comment',
    {
      title: 'Delete a comment',
      description:
        'Removes a comment permanently. Replies to it are not removed with it. ' +
        'Requires a confirmation token.',
      inputSchema: {
        comment_id: idParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ comment_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_comment',
            targets: [String(comment_id)],
            what: `delete comment ${comment_id}`,
            consequence:
              'The comment is gone for good; Wiki.js keeps no comment history.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'delete_comment',
              gql.DELETE_COMMENT,
              { id: comment_id }
            );
            assertSucceeded(
              objectOf(data.comments, 'the comment mutation').delete,
              'delete_comment'
            );
            return textResult(`Deleted comment ${comment_id}.`);
          }
        )
      )
  );
}
