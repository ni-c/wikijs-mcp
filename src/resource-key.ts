import { createHash } from 'node:crypto';

/**
 * The two key builders this server keeps for itself.
 *
 * The confirmation store, the prompt and `setResourceKey` come from
 * mcp-approval now. These two do not, because they are about *this* wiki: what
 * a Wiki.js target is made of, and which of its strings may appear in a
 * sentence a model reads.
 */

/**
 * A short, stable digest of a value, for binding a token to content.
 *
 * `setResourceKey` hashes the *set* of targets, so a target has to carry the
 * thing that decides the outcome, not a summary of it. Binding
 * `permissions.length` rather than the permissions means a confirmation for
 * `["read:pages"]` executes `["manage:system"]` — same count, same key, opposite
 * meaning. Anything free-form or list-shaped goes through here first.
 */
export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The one shape a confirmation may interpolate: a bare identifier.
 *
 * Several tools name their target in the confirmation text — a page path, a
 * tag, a login. They are safe today because their input schemas are narrow,
 * which is an invariant held two files away from the string it protects. This is
 * that invariant, enforced where the interpolation happens: whitespace or a
 * quote means the value is not an identifier, and a confirmation a model reads
 * is the wrong place to find that out gently.
 */
export function identifier(value: string, role: string): string {
  // eslint-disable-next-line no-control-regex -- matching them is the point
  if (/[\s\u0000-\u001f\u007f"'`\u200b-\u200f\u2060\ufeff]/.test(value)) {
    throw new Error(
      `wikijs-mcp: refusing to name a ${role} containing whitespace or quotes in a confirmation prompt`
    );
  }
  return value;
}
