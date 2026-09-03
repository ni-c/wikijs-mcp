import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';
import { setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';

import { errorResult } from './result.js';

/**
 * Wraps an operation that must not happen on the first call.
 *
 * Around twenty tools need this exact dance, and writing it out twenty times is
 * how one of them ends up subtly different — a resource key without the target
 * in it, say, which would let a confirmation for one page delete another.
 *
 * `targets` is what the token is bound to. It must contain everything that
 * decides *what* gets touched, not just the object's id: `migrate_pages_locale`
 * takes a source and a target locale, and a token issued for one direction must
 * not authorise the reverse.
 *
 * Nothing coming from the wiki — no title, description or comment body — may be
 * passed into `what` or `consequence`. Those strings are read by a model, and
 * this server's upstream content is written by whoever can edit a page.
 */
export async function guarded(
  server: McpServer,
  ctx: ServerContext,
  approval: Approver,
  confirmations: ConfirmationStore,
  options: {
    tool: string;
    targets: string[];
    what: string;
    consequence: string;
    confirmToken: string | undefined;
  },
  perform: () => Promise<CallToolResult>
): Promise<CallToolResult | InputRequiredResult> {
  const outcome = await approval.requestApproval(server, ctx, confirmations, {
    what: options.what,
    consequence: options.consequence,
    resourceKey: setResourceKey(options.tool, options.targets),
    token: options.confirmToken,
    toolName: options.tool,
    title: `${options.what[0]?.toUpperCase()}${options.what.slice(1)}?`,
    hint: 'Tick to go ahead, leave it to cancel.',
  });

  if (outcome.decision === 'approved') return perform();
  if (outcome.decision === 'declined') {
    return errorResult(`The user declined. ${options.tool} did nothing.`);
  }
  // A token that was sent and did not match is refused with the reason rather
  // than answered with a fresh prompt: it means the call carried a confirmation
  // issued for different arguments, which is what the key binds against. The
  // sentence comes from the library, so the whole fleet refuses alike.
  if (outcome.decision === 'rejected') return errorResult(outcome.reason);
  return outcome.result;
}
