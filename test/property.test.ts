import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assertWithinScope,
  buildPathScope,
  isWithinScope,
} from '../src/paths.js';
import {
  listOf,
  objectOf,
  redactSensitive,
  REDACTED,
} from '../src/normalize.js';
import { fingerprint, identifier, label } from '../src/resource-key.js';

/**
 * Properties of the write scope, the redaction filter and the prompt quoting.
 *
 * The write scope is the one that has to hold for every path rather than for
 * the ones a test names: its own comment records the trap it exists around — a
 * bare `startsWith` would make the scope `docs` cover `docs-archive`, which is
 * a different page tree that merely begins with the same letters.
 *
 * `identifier` and `label` guard the other direction. They decide what may be
 * interpolated into a confirmation prompt a person reads before approving a
 * write, and a value that can forge that sentence forges the approval.
 */

const RUNS = { numRuns: 500 };

const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
const path = fc
  .array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join('/'));

describe('the write scope is matched by segment, never by prefix', () => {
  /**
   * The trap the comment names. `docs` must not cover `docs-archive`, and this
   * is stated over every pair of a prefix and a suffix somebody could append
   * rather than over the one example that made it into a comment.
   */
  it('a sibling tree that shares the opening letters is outside', () => {
    fc.assert(
      fc.property(
        segment,
        fc.stringMatching(/^[a-z0-9-]{1,8}$/),
        path,
        (prefix, suffix, rest) => {
          const scope = buildPathScope(prefix);
          expect(isWithinScope(scope, prefix)).toBe(true);
          expect(isWithinScope(scope, `${prefix}/${rest}`)).toBe(true);
          expect(isWithinScope(scope, `${prefix}${suffix}`)).toBe(false);
          expect(isWithinScope(scope, `${prefix}${suffix}/${rest}`)).toBe(
            false
          );
        }
      ),
      RUNS
    );
  });

  it('leading and trailing slashes do not change the answer', () => {
    fc.assert(
      fc.property(segment, path, (prefix, rest) => {
        const scope = buildPathScope(prefix);
        for (const written of [
          `${prefix}/${rest}`,
          `/${prefix}/${rest}`,
          `${prefix}/${rest}/`,
          `//${prefix}/${rest}//`,
        ]) {
          expect(isWithinScope(scope, written)).toBe(true);
        }
      }),
      RUNS
    );
  });

  /**
   * An unset variable allows everything, and — the case the comment argues
   * about — so does an empty one. `WIKIJS_ALLOWED_PATHS=` in a compose file
   * must not mean "no path is writable", which would fail every write tool with
   * a message about a variable the operator thought they had left alone.
   */
  it('an unset or empty value allows every path', () => {
    fc.assert(
      fc.property(path, (candidate) => {
        for (const raw of [undefined, '', '   ', ',', ' , , ']) {
          expect(isWithinScope(buildPathScope(raw), candidate)).toBe(true);
        }
      }),
      RUNS
    );
  });

  it('a prefix with .. or a wildcard is refused rather than interpreted', () => {
    fc.assert(
      fc.property(
        segment,
        fc.constantFrom('..', '*', '../', '/..', 'a*b', '**'),
        (prefix, bad) => {
          expect(() => buildPathScope(`${prefix},${bad}`)).toThrow(
            'WIKIJS_ALLOWED_PATHS'
          );
        }
      ),
      RUNS
    );
  });

  it('assertWithinScope throws exactly when isWithinScope is false', () => {
    fc.assert(
      fc.property(segment, path, (prefix, candidate) => {
        const scope = buildPathScope(prefix);
        const inside = isWithinScope(scope, candidate);
        if (inside) {
          expect(() =>
            assertWithinScope(scope, candidate, 'page')
          ).not.toThrow();
        } else {
          expect(() => assertWithinScope(scope, candidate, 'page')).toThrow(
            candidate
          );
        }
      }),
      RUNS
    );
  });
});

describe('a confirmation prompt cannot be forged by its own arguments', () => {
  /**
   * `identifier` is the invariant enforced where the interpolation happens.
   * Whitespace, a quote or an invisible character means the value is not an
   * identifier, and a confirmation a model reads is the wrong place to find
   * that out gently.
   */
  it('refuses whitespace, quotes and invisible characters', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.constantFrom(' ', '\t', '\n', '\r', '"', "'", '`', '​', '‮', '﻿'),
        fc.stringMatching(/^[a-z]{0,8}$/),
        (head, injected, tail) => {
          expect(() =>
            identifier(`${head}${injected}${tail}`, 'page')
          ).toThrow();
        }
      ),
      RUNS
    );
  });

  it('passes an ordinary identifier through unchanged', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9/_-]{1,30}$/), (value) => {
        expect(identifier(value, 'page')).toBe(value);
      }),
      RUNS
    );
  });

  /**
   * `label` is the same class minus the ordinary space, because a group called
   * "Content Editors" is a value Wiki.js is perfectly happy with and exactly
   * what a person needs in front of them — "Administrators" and "Interns" are
   * the same shape and opposite meanings.
   */
  it('allows a space in a display name but nothing else that hides', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[A-Za-z]{1,10}$/), {
          minLength: 1,
          maxLength: 4,
        }),
        (words) => {
          const name = words.join(' ');
          expect(label(name, 'group')).toBe(name);
        }
      ),
      RUNS
    );
  });

  it('refuses a line break or an invisible character in a display name', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z ]{1,10}$/),
        fc.constantFrom('\n', '\r', '"', "'", '​', '‮', '﻿'),
        (name, injected) => {
          expect(() => label(`${name}${injected}`, 'group')).toThrow();
        }
      ),
      RUNS
    );
  });

  /**
   * A 255-character name would push the consequence sentence out of view, which
   * is padding by another route.
   */
  it('caps a display name so it cannot bury the rest of the prompt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300 }), (length) => {
        expect(label('a'.repeat(length), 'group').length).toBeLessThanOrEqual(
          61
        );
      }),
      RUNS
    );
  });
});

describe('the fingerprint binds a confirmation to its payload', () => {
  it('the same value always fingerprints the same, a different one never', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        expect(fingerprint(a)).toBe(fingerprint(a));
        fc.pre(JSON.stringify(a) !== JSON.stringify(b));
        expect(fingerprint(a)).not.toBe(fingerprint(b));
      }),
      RUNS
    );
  });

  /**
   * Totality. No caller passes `undefined` today — every optional argument is
   * guarded at the call site — but the docstring invites the next list-shaped
   * field through here, and `JSON.stringify(undefined)` is `undefined`, which
   * `update` refuses with ERR_INVALID_ARG_TYPE. A key builder that can take the
   * tool down is a worse failure than a key nobody likes.
   */
  it('never throws, whatever it is handed', () => {
    expect(fingerprint(undefined)).toBe(fingerprint(null));
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => fingerprint(value)).not.toThrow();
      }),
      RUNS
    );
  });
});

describe('credentials never reach the model', () => {
  it('a sensitive key is replaced at any depth, and the key survives', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('apiKey', 'token', 'password', 'secret'),
        fc.integer({ min: 0, max: 5 }),
        (key, depth) => {
          let value: unknown = { [key]: 'CREDENTIAL' };
          for (let i = 0; i < depth; i++) {
            value = i % 2 === 0 ? [value] : { nested: value };
          }
          const json = JSON.stringify(redactSensitive(value));
          expect(json).not.toContain('CREDENTIAL');
          expect(json).toContain(REDACTED);
        }
      ),
      RUNS
    );
  });

  it('response readers return the right shape or throw a named error', () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        try {
          expect(Array.isArray(listOf(body, 'pages'))).toBe(true);
        } catch (error) {
          expect((error as Error).message).toContain('pages');
        }
        try {
          const object = objectOf(body, 'page');
          expect(typeof object).toBe('object');
          expect(object).not.toBeNull();
        } catch (error) {
          expect((error as Error).message).toContain('page');
        }
      }),
      RUNS
    );
  });
});
