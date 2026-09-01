import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  confirmTokenParam,
  emailParam,
  idParam,
  limitParam,
} from '../schema.js';

import { assertSucceeded } from '../api.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
} from './annotations.js';
import { fingerprint } from '../resource-key.js';
import * as gql from '../gql/admin.js';
import { guarded } from '../guard.js';
import { listOf, objectOf } from '../normalize.js';
import { budgetedList, jsonResult, run, textResult } from '../result.js';
import type { ToolContext } from './context.js';

/**
 * User tools.
 *
 * Every write here is gated, including the ones that only flip a flag.
 * Deactivating an account locks somebody out, disabling their second factor
 * weakens it, and resetting a password mails them — none of those are things a
 * model should be able to do on the strength of a single sentence in a page it
 * just read. `passwordRaw` is accepted but never returned or logged.
 */
export function registerUserTools(
  server: McpServer,
  { api, approval, confirmations, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_users',
    {
      title: 'List users',
      description:
        'Lists the wiki’s user accounts. `providerKey` says how they log in — ' +
        '"local" for a Wiki.js password, anything else for an identity ' +
        'provider. Email addresses are returned because they are the login.',
      inputSchema: z.object({
        filter: z
          .string()
          .trim()
          .max(255)
          .optional()
          .describe('Substring filter over name and email.'),
        order_by: z
          .enum(['id', 'email', 'name', 'createdAt', 'updatedAt'])
          .optional(),
        limit: limitParam.optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ filter, order_by, limit }) =>
      run(async () => {
        const data = await api.execute('list_users', gql.LIST_USERS, {
          filter: filter ?? null,
          orderBy: order_by ?? null,
        });
        const users = listOf(
          objectOf(data.users, 'the user query').list,
          'users'
        );
        const shown = users.slice(0, limit ?? users.length);
        return budgetedList('users', shown, {
          extra: { total: users.length, shown: shown.length },
        });
      })
  );

  server.registerTool(
    'search_users',
    {
      title: 'Search users',
      description:
        'Finds users by name or email. Use it to resolve a person to the id ' +
        'that list_pages (creator_id, author_id) and the group tools take.',
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .describe('Name or email fragment.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ query }) =>
      run(async () => {
        const data = await api.execute('search_users', gql.SEARCH_USERS, {
          query,
        });
        const users = listOf(
          objectOf(data.users, 'the user query').search,
          'users'
        );
        return budgetedList('users', users, { extra: { count: users.length } });
      })
  );

  server.registerTool(
    'get_user',
    {
      title: 'Get a user',
      description:
        'Full detail for one account, including its group memberships and ' +
        'whether two-factor authentication is active. No credential of any kind ' +
        'is returned — Wiki.js does not expose one.',
      inputSchema: z.object({ user_id: idParam }),
      annotations: READ_ONLY,
    },
    async ({ user_id }) =>
      run(async () => {
        const data = await api.execute('get_user', gql.GET_USER, {
          id: user_id,
        });
        const user = objectOf(
          objectOf(data.users, 'the user query').single,
          `user ${user_id}`
        );
        return jsonResult({ user });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'create_user',
    {
      title: 'Create a user',
      description:
        'Creates an account. For a local account supply a password, or set ' +
        'send_welcome_email so Wiki.js mails an invitation instead. Groups are ' +
        'given by id — list_groups has them, and an account in no group can log ' +
        'in but see nothing.',
      inputSchema: z.object({
        email: emailParam,
        name: z.string().trim().min(1).max(255).describe('Display name.'),
        password: z
          .string()
          .min(8, 'Wiki.js requires at least 8 characters')
          .max(255)
          .optional()
          .describe(
            'Initial password for a local account. Never echoed back by this server.'
          ),
        provider_key: z
          .string()
          .trim()
          .max(255)
          .optional()
          .describe('Authentication provider (default "local").'),
        groups: z
          .array(idParam)
          .max(50)
          .optional()
          .describe('Group ids to put the account in.'),
        must_change_password: z.boolean().optional(),
        send_welcome_email: z.boolean().optional(),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: WRITE,
    },
    async (
      {
        email,
        name,
        password,
        provider_key,
        groups,
        must_change_password,
        send_welcome_email,
        confirm_token,
      },
      mcp
    ) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'create_user',
            // The group list is part of the target: a confirmation for an
            // account in no group must not create one in the administrators.
            targets: [
              `email:${email}`,
              ...(groups ?? []).map((id) => `group:${id}`),
            ],
            what: `create a wiki account in ${(groups ?? []).length} group(s)`,
            consequence:
              'The account can sign in to the wiki with whatever its groups allow.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('create_user', gql.CREATE_USER, {
              email,
              name,
              passwordRaw: password ?? null,
              providerKey: provider_key ?? 'local',
              groups: groups ?? [],
              mustChangePassword: must_change_password ?? false,
              sendWelcomeEmail: send_welcome_email ?? false,
            });
            const mutation = objectOf(data.users, 'the user mutation');
            assertSucceeded(mutation.create, 'create_user');

            // Wiki.js declares `user` on the create response and then returns
            // null in it, so the new account's id is simply not in the answer.
            // Looking it up by email is the only way to hand back something the
            // caller can use — every other tool here takes a user id.
            const found = await api.execute('create_user', gql.SEARCH_USERS, {
              query: email,
            });
            const match = listOf(
              objectOf(found.users, 'the user query').search,
              'users'
            ).find((u) => (u as { email?: string }).email === email);

            return jsonResult({
              created: match ?? {
                email,
                note:
                  'The account was created, but Wiki.js returned no id for it ' +
                  'and it could not be found by email afterwards. Use ' +
                  'search_users to locate it.',
              },
            });
          }
        )
      )
  );

  server.registerTool(
    'update_user',
    {
      title: 'Update a user',
      description:
        'Changes an account’s details or its group membership. The groups list ' +
        'replaces the existing one rather than adding to it — use ' +
        'assign_user_to_group for a single addition.',
      inputSchema: z.object({
        user_id: idParam,
        email: emailParam.optional(),
        name: z.string().trim().min(1).max(255).optional(),
        groups: z
          .array(idParam)
          .max(50)
          .optional()
          .describe('Replaces the whole group list.'),
        location: z.string().trim().max(255).optional(),
        job_title: z.string().trim().max(255).optional(),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
    },
    async (
      { user_id, email, name, groups, location, job_title, confirm_token },
      mcp
    ) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'update_user',
            // Every supplied field, not just the groups. The email is the
            // sign-in address for a local account, so a token issued for a job
            // title must not be able to repoint it at somebody else's mailbox —
            // after which reset_user_password mails them the link.
            targets: [
              `user:${user_id}`,
              ...(email === undefined ? [] : [`email:${email}`]),
              ...(name === undefined ? [] : [`name:${fingerprint(name)}`]),
              ...(location === undefined
                ? []
                : [`location:${fingerprint(location)}`]),
              ...(job_title === undefined
                ? []
                : [`job:${fingerprint(job_title)}`]),
              ...(groups === undefined
                ? []
                : ['groups', ...groups.map((id) => `group:${id}`)]),
            ],
            what: [
              `update user ${user_id}:`,
              email === undefined ? '' : 'change their sign-in address,',
              groups === undefined
                ? ''
                : `set their membership to ${groups.length} group(s),`,
              'change profile fields',
            ]
              .filter(Boolean)
              .join(' '),
            consequence: [
              email === undefined
                ? ''
                : 'Changing the email changes the address the account signs in with and receives password resets at.',
              groups === undefined
                ? ''
                : 'The group list is replaced wholesale, so this can grant or remove access.',
              email === undefined && groups === undefined
                ? 'Only profile fields change.'
                : '',
            ]
              .filter(Boolean)
              .join(' '),
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('update_user', gql.UPDATE_USER, {
              id: user_id,
              email: email ?? null,
              name: name ?? null,
              groups: groups ?? null,
              location: location ?? null,
              jobTitle: job_title ?? null,
            });
            assertSucceeded(
              objectOf(data.users, 'the user mutation').update,
              'update_user'
            );
            return textResult(`Updated user ${user_id}.`);
          }
        )
      )
  );

  server.registerTool(
    'delete_user',
    {
      title: 'Delete a user',
      description:
        'Removes an account. Wiki.js needs somebody to inherit the pages it ' +
        'authored, so replace_with_user_id is required — pass the id of the ' +
        'account that should own them afterwards. Requires a confirmation token.',
      inputSchema: z.object({
        user_id: idParam,
        replace_with_user_id: idParam.describe(
          'Account that inherits the deleted user’s pages.'
        ),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ user_id, replace_with_user_id, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_user',
            // Labelled: setResourceKey sorts, so a bare pair of ids would
            // make "delete 1, reassign to 2" and "delete 2, reassign to 1" the
            // same confirmation.
            targets: [
              `delete:${user_id}`,
              `replacement:${replace_with_user_id}`,
            ],
            what: `delete user ${user_id} and reassign their pages to user ${replace_with_user_id}`,
            consequence:
              'The account is removed permanently and loses access to the wiki.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('delete_user', gql.DELETE_USER, {
              id: user_id,
              replaceId: replace_with_user_id,
            });
            assertSucceeded(
              objectOf(data.users, 'the user mutation').delete,
              'delete_user'
            );
            return textResult(`Deleted user ${user_id}.`);
          }
        )
      )
  );

  server.registerTool(
    'set_user_active',
    {
      title: 'Activate or deactivate a user',
      description:
        'Switches an account on or off. A deactivated account keeps its pages ' +
        'and groups but cannot sign in — the reversible alternative to ' +
        'delete_user. Requires a confirmation token.',
      inputSchema: z.object({
        user_id: idParam,
        active: z.boolean().describe('True to activate, false to deactivate.'),
        confirm_token: confirmTokenParam.optional(),
      }),
      // Not idempotent although the end state is: the confirmation token is
      // single-use, so the second identical call needs a fresh one.
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ user_id, active, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'set_user_active',
            targets: [`user:${user_id}`, `active:${String(active)}`],
            what: `${active ? 'activate' : 'deactivate'} user ${user_id}`,
            consequence: active
              ? 'The account can sign in again.'
              : 'The account is locked out immediately.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'set_user_active',
              active ? gql.ACTIVATE_USER : gql.DEACTIVATE_USER,
              { id: user_id }
            );
            const mutation = objectOf(data.users, 'the user mutation');
            assertSucceeded(
              active ? mutation.activate : mutation.deactivate,
              'set_user_active'
            );
            return textResult(
              `User ${user_id} is now ${active ? 'active' : 'deactivated'}.`
            );
          }
        )
      )
  );

  server.registerTool(
    'verify_user',
    {
      title: 'Mark a user as verified',
      description:
        'Marks an account’s email as verified, which is otherwise done by the ' +
        'user clicking a link. Requires a confirmation token.',
      inputSchema: z.object({
        user_id: idParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ user_id, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'verify_user',
            targets: [String(user_id)],
            what: `mark user ${user_id} as verified`,
            consequence:
              'The account skips the email confirmation it would otherwise need.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('verify_user', gql.VERIFY_USER, {
              id: user_id,
            });
            assertSucceeded(
              objectOf(data.users, 'the user mutation').verify,
              'verify_user'
            );
            return textResult(`User ${user_id} is verified.`);
          }
        )
      )
  );

  server.registerTool(
    'set_user_tfa',
    {
      title: 'Turn two-factor authentication on or off',
      description:
        'Switches an account’s second factor. Turning it OFF weakens that ' +
        'account and is the reason this is gated; turning it on forces the user ' +
        'to enrol at their next sign-in. Requires a confirmation token.',
      inputSchema: z.object({
        user_id: idParam,
        enabled: z
          .boolean()
          .describe('True to require 2FA, false to remove it.'),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ user_id, enabled, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'set_user_tfa',
            targets: [`user:${user_id}`, `tfa:${String(enabled)}`],
            what: `turn two-factor authentication ${enabled ? 'on' : 'off'} for user ${user_id}`,
            consequence: enabled
              ? 'The user must enrol a second factor at their next sign-in.'
              : 'The account loses its second factor and is protected by its password alone.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'set_user_tfa',
              enabled ? gql.ENABLE_TFA : gql.DISABLE_TFA,
              { id: user_id }
            );
            const mutation = objectOf(data.users, 'the user mutation');
            assertSucceeded(
              enabled ? mutation.enableTFA : mutation.disableTFA,
              'set_user_tfa'
            );
            return textResult(
              `Two-factor authentication is now ${enabled ? 'required' : 'off'} for user ${user_id}.`
            );
          }
        )
      )
  );

  server.registerTool(
    'reset_user_password',
    {
      title: 'Reset a user’s password',
      description:
        'Starts Wiki.js’ own password reset for a local account, which emails ' +
        'the user a link. No password is chosen or returned here. Requires a ' +
        'confirmation token.',
      inputSchema: z.object({
        user_id: idParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ user_id, confirm_token }, mcp) =>
      run(async () =>
        guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'reset_user_password',
            targets: [String(user_id)],
            what: `reset the password of user ${user_id}`,
            consequence:
              'Wiki.js emails the account a reset link; their current password stops working.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'reset_user_password',
              gql.RESET_PASSWORD,
              { id: user_id }
            );
            assertSucceeded(
              objectOf(data.users, 'the user mutation').resetPassword,
              'reset_user_password'
            );
            return textResult(`Password reset started for user ${user_id}.`);
          }
        )
      )
  );
}
