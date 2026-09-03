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
 * Every character that can make a prompt read differently than it executes.
 *
 * Stated as Unicode general categories rather than as a list of code points,
 * because a list is a claim about what somebody happened to think of — and the
 * list this replaced was missing the half that matters. The four `C`/`Z`
 * categories are the whole class by definition:
 *
 * - `Cc` — the C0 and C1 controls, and DEL.
 * - `Cf` — the format characters, which is where an enumeration goes wrong. It
 *   holds the zero-width family *and* the eight bidi overrides and isolates
 *   (U+202A–U+202E, U+2066–U+2069). RIGHT-TO-LEFT OVERRIDE is why that matters:
 *   after it a client renders the rest of the line backwards, so the human reads
 *   one destination path and the mutation writes another.
 * - `Zl`, `Zp`, `Zs` and `\s` — every separator there is, so a value cannot open
 *   a second line in a sentence that promised one.
 *
 * Quotes and backticks stay in the class: they end the value visibly rather
 * than invisibly, which is a different way of saying something the server did
 * not.
 *
 * Deliberately *not* covered: confusables. Cyrillic `dосs` renders as `docs`,
 * and no character class reaches that — it is a property of the alphabet, not
 * of a category, and covering four categories does not make it covered.
 */
const UNSAFE_IN_A_PROMPT = /[\s"'`\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/u;

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
  if (UNSAFE_IN_A_PROMPT.test(value)) {
    throw new Error(
      `wikijs-mcp: refusing to name a ${role} containing whitespace, quotes or ` +
        'invisible characters in a confirmation prompt'
    );
  }
  return value;
}

/** Past this a name stops informing the reader and starts burying the rest. */
const MAX_LABEL_LENGTH = 60;

/**
 * A short piece of free text a confirmation may quote — a display name.
 *
 * {@link identifier} is the wrong instrument for a group called "Content
 * Editors": it rejects the space, and the call fails on a value Wiki.js is
 * perfectly happy with. But the display name is exactly what a person needs in
 * front of them when the operation renames something, because "Administrators"
 * and "Interns" are the same shape and opposite meanings.
 *
 * So: the same class as `identifier` minus the ordinary space, plus a length
 * cap — a 255-character name would push the consequence sentence out of view,
 * which is padding by another route.
 */
export function label(value: string, role: string): string {
  if (UNSAFE_IN_A_PROMPT.test(value.replaceAll(' ', ''))) {
    throw new Error(
      `wikijs-mcp: refusing to quote a ${role} containing line breaks, quotes ` +
        'or invisible characters in a confirmation prompt'
    );
  }
  return value.length > MAX_LABEL_LENGTH
    ? `${value.slice(0, MAX_LABEL_LENGTH)}…`
    : value;
}
