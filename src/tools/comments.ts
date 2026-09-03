import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { marked, plain } from '../output-schema.js';
import {
  budgetedList,
  budgetedUntrustedResult,
  jsonResult,
  run,
  sentenceResult,
} from '../result.js';
import {
  confirmTokenParam,
  idParam,
  localeParam,
  pagePathParam,
} from '../schema.js';

import { assertSucceeded } from '../api.js';
import { DESTRUCTIVE, READ_ONLY, WRITE } from './annotations.js';
import { fingerprint } from '../resource-key.js';
import * as gql from '../gql/admin.js';
import * as pageGql from '../gql/pages.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { assertWithinScope, PathScopeError } from '../paths.js';
import type { ToolContext } from './context.js';

/**
 * Refuses a comment write that the path scope cannot be applied to.
 *
 * `CommentPost` carries no page id and Wiki.js offers no way to look one up, so
 * for an existing comment there is genuinely no way to tell which page it sits
 * on. An operator who set WIKIJS_ALLOWED_PATHS was told nothing outside it can
 * be written; saying so is better than making a silent exception.
 * `create_comment` is unaffected — it is given the page.
 */
function assertCommentScopable(
  scope: { active: boolean; prefixes: readonly string[] },
  tool: string
): void {
  if (!scope.active) return;
  throw new PathScopeError(
    `${tool} cannot be confined to WIKIJS_ALLOWED_PATHS ` +
      `(${scope.prefixes.join(', ')}): Wiki.js does not report which page a ` +
      'comment belongs to, so this server cannot tell whether it is inside the ' +
      'allowed area. Unset the variable to manage comments.'
  );
}

const commentBodyParam = z
  .string()
  .trim()
  .min(1, 'a comment cannot be empty')
  .max(50_000)
  .describe('Comment body, in markdown.');

export function registerCommentTools(
  server: McpServer,
  { api, approval, confirmations, scope, readOnly }: ToolContext
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
      inputSchema: z.object({
        path: pagePathParam,
        locale: localeParam.optional(),
      }),
      annotations: READ_ONLY,
      outputSchema: marked(),
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
      inputSchema: z.object({ comment_id: idParam }),
      annotations: READ_ONLY,
      outputSchema: marked(),
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
      inputSchema: z.object({
        page_id: idParam.describe('Page id the comment belongs to.'),
        content: commentBodyParam,
        reply_to: idParam.optional().describe('Comment id this replies to.'),
      }),
      annotations: WRITE,
      outputSchema: plain(),
    },
    async ({ page_id, content, reply_to }) =>
      run(async () => {
        if (scope.active) {
          const page = objectOf(
            objectOf(
              (
                await api.execute('create_comment', pageGql.GET_PAGE_METADATA, {
                  id: page_id,
                })
              ).pages,
              'the page query'
            ).single,
            `page ${page_id}`
          );
          assertWithinScope(scope, String(page.path), 'page path');
        }
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
      inputSchema: z.object({
        comment_id: idParam,
        content: commentBodyParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
      outputSchema: plain(),
    },
    async ({ comment_id, content, confirm_token }, mcp) =>
      run(async () => {
        assertCommentScopable(scope, 'update_comment');
        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'update_comment',
            // The new text is part of the target: a confirmation for one
            // replacement must not write a different one.
            targets: [
              `comment:${comment_id}`,
              `content:${fingerprint(content)}`,
            ],
            what: `replace the text of comment ${comment_id}`,
            consequence:
              'It is somebody else’s writing and Wiki.js keeps no comment history, so the previous text is gone for good.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'update_comment',
              gql.UPDATE_COMMENT,
              { id: comment_id, content }
            );
            assertSucceeded(
              objectOf(data.comments, 'the comment mutation').update,
              'update_comment'
            );
            return sentenceResult(`Updated comment ${comment_id}.`, {
              comment_id,
              updated: true,
            });
          }
        );
      })
  );

  server.registerTool(
    'delete_comment',
    {
      title: 'Delete a comment',
      description:
        'Removes a comment permanently. Replies to it are not removed with it. ' +
        'Requires a confirmation token.',
      inputSchema: z.object({
        comment_id: idParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
      outputSchema: plain(),
    },
    async ({ comment_id, confirm_token }, mcp) =>
      run(async () => {
        assertCommentScopable(scope, 'delete_comment');
        return guarded(
          server,
          mcp,
          approval,
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
            return sentenceResult(`Deleted comment ${comment_id}.`, {
              deleted_comment_id: comment_id,
            });
          }
        );
      })
  );
}
