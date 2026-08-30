import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  confirmationPrompt,
  setResourceKey,
  type ConfirmationStore,
} from './confirm.js';
import { errorResult, textResult } from './result.js';

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
  confirmations: ConfirmationStore,
  options: {
    tool: string;
    targets: string[];
    what: string;
    consequence: string;
    confirmToken: string | undefined;
  },
  perform: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  const resource = setResourceKey(options.tool, options.targets);

  if (confirmations.consume(resource, options.confirmToken)) {
    return perform();
  }

  if (options.confirmToken !== undefined) {
    return errorResult(
      'The confirmation token is invalid, expired or was issued for different ' +
        `arguments. Call ${options.tool} without a token to get a new one.`
    );
  }

  const token = confirmations.issue(resource);
  return textResult(
    confirmationPrompt(
      options.what,
      options.consequence,
      options.tool,
      token,
      confirmations.ttlMinutes
    )
  );
}
