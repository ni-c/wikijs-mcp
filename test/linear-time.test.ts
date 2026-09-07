import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { outlineOf, sectionOf } from '../src/markdown.js';
import {
  cleanText,
  redactSensitive,
  sanitizeErrorBody,
} from '../src/normalize.js';
import {
  buildPathScope,
  isWithinScope,
  stripSurroundingSlashes,
  stripTrailingSlashes,
} from '../src/paths.js';

/**
 * Every scan over text the wiki wrote, timed at its ceiling.
 *
 * The heading parser is why this file exists. `/^(#{1,6})\s+(.+?)\s*#*\s*$/`
 * was cubic in the whitespace of a line — `# x`, four thousand spaces and a
 * `y` cost 8.6 seconds on the main thread, from `get_page` with
 * `mode="outline"` or `section=`, on a line anybody with edit rights can
 * write. The limit here is a band between two answers, not a budget: a linear
 * scan finishes these in milliseconds, and the shapes that fail take seconds
 * or never finish. Measured as the fastest of three runs, so a busy machine
 * adds noise in one direction only.
 */
const LIMIT_MS = 1000;
const RUN = 200_000;

function fastest(fn: () => unknown, runs = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('every scan over wiki text is linear at its ceiling', () => {
  const cases: Array<[string, () => unknown]> = [
    [
      'an ATX heading line that is mostly spaces (the cubic case)',
      () => outlineOf(`# x${' '.repeat(RUN)}y`),
    ],
    ['a heading line of hashes', () => outlineOf(`# ${'#'.repeat(RUN)}`)],
    [
      'a heading line of alternating spaces and hashes',
      () => outlineOf(`# x${' #'.repeat(RUN / 2)}`),
    ],
    [
      'a heading line of tabs and a trailing character',
      () => outlineOf(`##\t${'\t'.repeat(RUN)}y`),
    ],
    [
      'a setext underline that never ends',
      () => outlineOf(`title\n${'='.repeat(RUN)}x`),
    ],
    [
      'a setext underline of dashes',
      () => outlineOf(`title\n${'-'.repeat(RUN)} x`),
    ],
    [
      'a page of a hundred thousand identical headings, addressed by section',
      () => sectionOf('# h\n'.repeat(RUN / 2), 'h'),
    ],
    ['a path of slashes', () => stripSurroundingSlashes('/'.repeat(RUN))],
    ['a URL path of slashes', () => stripTrailingSlashes('/'.repeat(RUN))],
    [
      'a scope check on a path of slashes',
      () => isWithinScope(buildPathScope('docs'), '/'.repeat(RUN)),
    ],
    [
      'a megabyte of letters with no URL in it',
      () => redactSensitive('a'.repeat(5 * RUN)),
    ],
    [
      'a megabyte of scheme separators',
      () => redactSensitive('a://'.repeat(RUN)),
    ],
    [
      'one separator and a megabyte of userinfo',
      () => redactSensitive(`x://${'u'.repeat(5 * RUN)}`),
    ],
    [
      'a megabyte of userinfo with an @ at the end',
      () => redactSensitive(`x://${'u'.repeat(5 * RUN)}@`),
    ],
    [
      'a megabyte of control characters',
      () => cleanText(String.fromCharCode(27).repeat(5 * RUN)),
    ],
    ['a megabyte of error body', () => sanitizeErrorBody('e'.repeat(5 * RUN))],
  ];

  it.each(cases)('%s', (_, fn) => {
    expect(fastest(fn)).toBeLessThan(LIMIT_MS);
  });
});

describe('the hand-written heading parser reads what the expression read', () => {
  // The expression is kept here as the specification it was, and run only on
  // short lines, where it is fast. The parser has to agree with it on every
  // line the alphabet can produce — including the ones that are not headings.
  const specification = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

  it('agrees on every short line over the heading alphabet', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom('#', ' ', '\t', 'x', '=', '-'),
          maxLength: 24,
        }),
        (line) => {
          const expected = specification.exec(line);
          const parsed = outlineOf(line);
          // `#  ` satisfied the expression with a title made of the second
          // space, which trimmed to nothing — a heading with no text. The
          // parser refuses that one, and it is the only place they differ.
          if (
            expected?.[1] === undefined ||
            expected[2] === undefined ||
            expected[2].trim() === ''
          ) {
            expect(parsed).toEqual([]);
            return;
          }
          expect(parsed).toEqual([
            {
              level: expected[1].length,
              title: expected[2].trim(),
              line: 1,
              offset: 0,
            },
          ]);
        }
      ),
      { numRuns: 2000 }
    );
  });
});
