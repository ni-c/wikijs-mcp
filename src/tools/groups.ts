import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertSucceeded } from '../api.js';
import * as gql from '../gql/admin.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import { confirmTokenParam, idParam, localeParam } from '../schema.js';
import type { ToolContext } from './context.js';

/**
 * A page rule.
 *
 * This is where a Wiki.js group actually gets its power: `permissions` is the
 * global list, and `pageRules` narrows or widens it per path. Getting one wrong
 * silently opens or closes part of the wiki, which is why `update_group` is
 * gated and why its description insists on reading the group first.
 */
const pageRuleParam = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe(
        'Rule id. Reuse the one from get_group, or invent a unique string.'
      ),
    deny: z.boolean().describe('True to deny, false to allow.'),
    match: z
      .enum(['START', 'EXACT', 'END', 'REGEX', 'TAG'])
      .describe('How path is matched.'),
    roles: z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(30)
      .describe('Permissions this rule covers, e.g. ["read:pages"].'),
    path: z.string().trim().max(2048).describe('Path or pattern to match.'),
    locales: z
      .array(localeParam)
      .max(30)
      .describe('Locales the rule applies to. Empty means all.'),
  })
  .describe('One page rule.');

export function registerGroupTools(
  server: McpServer,
  { api, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_groups',
    {
      title: 'List groups',
      description:
        'Lists the wiki’s groups with how many users each has. Groups marked ' +
        'isSystem are Wiki.js’ own Administrators and Guests — they exist ' +
        'always and should not be deleted.',
      inputSchema: {
        filter: z.string().trim().max(255).optional(),
        order_by: z.enum(['id', 'name', 'createdAt', 'updatedAt']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filter, order_by }) =>
      run(async () => {
        const data = await api.execute('list_groups', gql.LIST_GROUPS, {
          filter: filter ?? null,
          orderBy: order_by ?? null,
        });
        const groups = listOf(
          objectOf(data.groups, 'the group query').list,
          'groups'
        );
        return budgetedList('groups', groups, {
          extra: { count: groups.length },
        });
      })
  );

  server.registerTool(
    'get_group',
    {
      title: 'Get a group',
      description:
        'Returns one group with its global permissions, its page rules and its ' +
        'members. This is the authoritative answer to "who can see or edit ' +
        'what" — and it is what update_group needs as its starting point, ' +
        'because that mutation replaces the whole rule set.',
      inputSchema: { group_id: idParam },
      annotations: { readOnlyHint: true },
    },
    async ({ group_id }) =>
      run(async () => {
        const data = await api.execute('get_group', gql.GET_GROUP, {
          id: group_id,
        });
        const group = objectOf(
          objectOf(data.groups, 'the group query').single,
          `group ${group_id}`
        );
        return jsonResult({ group });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'create_group',
    {
      title: 'Create a group',
      description:
        'Creates an empty group. It starts with no permissions and no page ' +
        'rules, so it grants nothing until update_group is called.',
      inputSchema: {
        name: z.string().trim().min(1).max(255).describe('Group name.'),
      },
      annotations: { idempotentHint: false },
    },
    async ({ name }) =>
      run(async () => {
        const data = await api.execute('create_group', gql.CREATE_GROUP, {
          name,
        });
        const mutation = objectOf(data.groups, 'the group mutation');
        assertSucceeded(mutation.create, 'create_group');
        return jsonResult({
          created: (mutation.create as { group?: unknown }).group,
        });
      })
  );

  server.registerTool(
    'update_group',
    {
      title: 'Update a group’s permissions',
      description:
        'Replaces a group’s name, permissions and page rules wholesale — this ' +
        'is not a partial update, and omitting a rule deletes it. Read the ' +
        'group with get_group first and send back the full set with your ' +
        'change applied. Requires a confirmation token, because this is the ' +
        'call that decides who can read and edit the wiki.',
      inputSchema: {
        group_id: idParam,
        name: z.string().trim().min(1).max(255),
        permissions: z
          .array(z.string().trim().min(1).max(64))
          .max(50)
          .describe(
            'Global permissions, e.g. ["read:pages","write:pages"]. Replaces the existing list.'
          ),
        page_rules: z
          .array(pageRuleParam)
          .max(200)
          .describe('Complete page rule set. Replaces the existing one.'),
        redirect_on_login: z
          .string()
          .trim()
          .max(2048)
          .optional()
          .describe('Where members land after signing in (default "/").'),
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { idempotentHint: true },
    },
    async ({
      group_id,
      name,
      permissions,
      page_rules,
      redirect_on_login,
      confirm_token,
    }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'update_group',
            targets: [
              `group:${group_id}`,
              `permissions:${permissions.length}`,
              `rules:${page_rules.length}`,
            ],
            what: `replace the permissions of group ${group_id} with ${permissions.length} permission(s) and ${page_rules.length} page rule(s)`,
            consequence:
              'This decides what every member of the group can read and edit; omitted rules are deleted.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('update_group', gql.UPDATE_GROUP, {
              id: group_id,
              name,
              permissions,
              pageRules: page_rules,
              redirectOnLogin: redirect_on_login ?? '/',
            });
            assertSucceeded(
              objectOf(data.groups, 'the group mutation').update,
              'update_group'
            );
            return textResult(`Updated group ${group_id}.`);
          }
        )
      )
  );

  server.registerTool(
    'delete_group',
    {
      title: 'Delete a group',
      description:
        'Removes a group. Its members keep their accounts but lose whatever ' +
        'access the group gave them. Requires a confirmation token.',
      inputSchema: {
        group_id: idParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ group_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'delete_group',
            targets: [String(group_id)],
            what: `delete group ${group_id}`,
            consequence:
              'Every member loses the access this group granted. The accounts remain.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('delete_group', gql.DELETE_GROUP, {
              id: group_id,
            });
            assertSucceeded(
              objectOf(data.groups, 'the group mutation').delete,
              'delete_group'
            );
            return textResult(`Deleted group ${group_id}.`);
          }
        )
      )
  );

  server.registerTool(
    'assign_user_to_group',
    {
      title: 'Add a user to a group',
      description:
        'Adds one account to one group, leaving its other memberships alone — ' +
        'the additive counterpart to update_user’s groups list. Requires a ' +
        'confirmation token, because a group is what grants access.',
      inputSchema: {
        group_id: idParam,
        user_id: idParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { idempotentHint: false },
    },
    async ({ group_id, user_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'assign_user_to_group',
            targets: [`group:${group_id}`, `user:${user_id}`],
            what: `add user ${user_id} to group ${group_id}`,
            consequence:
              'The account gains everything this group is allowed to do.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'assign_user_to_group',
              gql.ASSIGN_USER,
              { groupId: group_id, userId: user_id }
            );
            assertSucceeded(
              objectOf(data.groups, 'the group mutation').assignUser,
              'assign_user_to_group'
            );
            return textResult(`Added user ${user_id} to group ${group_id}.`);
          }
        )
      )
  );

  server.registerTool(
    'unassign_user_from_group',
    {
      title: 'Remove a user from a group',
      description:
        'Takes one account out of one group. Requires a confirmation token — ' +
        'removing somebody from their only group leaves them able to sign in ' +
        'and see nothing.',
      inputSchema: {
        group_id: idParam,
        user_id: idParam,
        confirm_token: confirmTokenParam.optional(),
      },
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ group_id, user_id, confirm_token }) =>
      run(async () =>
        guarded(
          confirmations,
          {
            tool: 'unassign_user_from_group',
            targets: [`group:${group_id}`, `user:${user_id}`],
            what: `remove user ${user_id} from group ${group_id}`,
            consequence:
              'The account loses the access this group granted; if it was their only group, they see nothing.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'unassign_user_from_group',
              gql.UNASSIGN_USER,
              { groupId: group_id, userId: user_id }
            );
            assertSucceeded(
              objectOf(data.groups, 'the group mutation').unassignUser,
              'unassign_user_from_group'
            );
            return textResult(
              `Removed user ${user_id} from group ${group_id}.`
            );
          }
        )
      )
  );
}
