import { parentPort, workerData } from 'node:worker_threads';

/**
 * Runs the caller's regular expression against page bodies, off the main thread.
 *
 * The whole point of this file is that it can be killed. A regular expression is
 * a program, and a short one can run for a very long time: `(a+)+$` against
 * thirty-two `a` characters followed by a `b` does not finish in half a minute,
 * and the cost doubles per character. There is no way to interrupt a running
 * `RegExp.test` — no timeout option, no abort signal — so the only defence is to
 * run it somewhere that can be terminated, which is here.
 *
 * The pattern reaches a model from wiki pages it just read, so "nobody would
 * write that" is not an argument.
 */

export interface GrepRequest {
  pattern: string;
  ignoreCase: boolean;
  contextLines: number;
  maxMatchesPerPage: number;
  maxMatches: number;
  pages: Array<{
    id: number;
    path: string;
    title?: string;
    locale?: string;
    content: string;
  }>;
}

export interface GrepHit {
  id: number;
  path: string;
  title?: string;
  locale?: string;
  matches: Array<{ line: number; text: string }>;
}

export interface GrepResponse {
  hits: GrepHit[];
  matchCount: number;
  /** True when the match budget stopped the scan early. */
  stoppedAtLimit: boolean;
}

function run(request: GrepRequest): GrepResponse {
  const regex = new RegExp(request.pattern, request.ignoreCase ? 'i' : '');
  const hits: GrepHit[] = [];
  let matchCount = 0;
  let stoppedAtLimit = false;

  for (const page of request.pages) {
    if (matchCount >= request.maxMatches) {
      stoppedAtLimit = true;
      break;
    }
    const lines = page.content.split('\n');
    const matches: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      // `regex.test` on a global regex would advance lastIndex between calls;
      // the flags above never include `g`, so each line is tested from the start.
      if (!regex.test(lines[i] ?? '')) continue;
      matchCount++;
      matches.push({
        line: i + 1,
        text: lines
          .slice(
            Math.max(0, i - request.contextLines),
            i + request.contextLines + 1
          )
          .join('\n'),
      });
      if (matches.length >= request.maxMatchesPerPage) break;
      if (matchCount >= request.maxMatches) {
        stoppedAtLimit = true;
        break;
      }
    }
    if (matches.length > 0) {
      hits.push({
        id: page.id,
        path: page.path,
        ...(page.title !== undefined ? { title: page.title } : {}),
        ...(page.locale !== undefined ? { locale: page.locale } : {}),
        matches,
      });
    }
  }

  return { hits, matchCount, stoppedAtLimit };
}

if (parentPort) {
  parentPort.postMessage(run(workerData as GrepRequest));
}
