import { Worker } from 'node:worker_threads';

import type { GrepRequest, GrepResponse } from './grep-worker.js';

export type { GrepHit, GrepRequest, GrepResponse } from './grep-worker.js';

/**
 * How long a caller's pattern may run before it is killed.
 *
 * Generous for any pattern anyone means, and finite for the ones they do not:
 * a catastrophically backtracking expression would otherwise run for hours on
 * the one thread this server has.
 */
export const MATCH_TIMEOUT_MS = 5_000;

export class PatternTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `the pattern did not finish within ${Math.round(timeoutMs / 1000)} seconds ` +
        'and was stopped. Some expressions take exponential time on ordinary ' +
        'text — nested quantifiers such as "(a+)+" are the usual cause. Anchor ' +
        'the pattern, avoid nesting one quantifier inside another, and narrow ' +
        'the search with path_prefix or tags.'
    );
    this.name = 'PatternTimeoutError';
  }
}

/**
 * Matches page bodies against the caller's pattern in a worker thread.
 *
 * Not for tidiness: `RegExp.test` cannot be interrupted — there is no timeout
 * option and no abort signal — so the only way to bound it is to run it
 * somewhere that can be terminated. Everything else in this server would stop
 * answering otherwise, with no error and nothing in the log.
 */
export async function matchPages(request: GrepRequest): Promise<GrepResponse> {
  // Same extension as this module: `.js` next to the compiled output at
  // runtime, `.ts` next to the source under vitest, which runs the sources
  // directly and would otherwise look for a sibling that is never built.
  const worker = new Worker(
    new URL(
      import.meta.url.endsWith('.ts') ? './grep-worker.ts' : './grep-worker.js',
      import.meta.url
    ),
    { workerData: request }
  );

  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<GrepResponse>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new PatternTimeoutError(MATCH_TIMEOUT_MS));
      }, MATCH_TIMEOUT_MS);
      worker.once('message', (value: GrepResponse) => {
        resolve(value);
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0)
          reject(new Error(`the match worker exited with code ${code}`));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    // Terminate unconditionally: on the timeout path the worker is still busy
    // inside the regular expression and will never exit on its own.
    await worker.terminate();
  }
}
