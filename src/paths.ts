import { quoted } from './normalize.js';

/**
 * Confines the write tools to a set of page path prefixes.
 *
 * A Wiki.js API key is administrative by construction — the key dialog offers
 * "full access" and a group, and most people take full access. `WIKIJS_READ_ONLY`
 * is the all-or-nothing answer to that; this is the one in between: writes are
 * allowed, but only under `docs/` and `team/notes`.
 *
 * Reads are deliberately *not* scoped. A path scope on reads would filter the
 * tree, the search results and the link graph, which turns a wiki into a
 * confusing half-wiki — and the API key's own group permissions are the right
 * tool for hiding pages, because they hide them from the web UI too.
 */
export class PathScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathScopeError';
  }
}

export interface PathScope {
  /** False when the variable was unset — then every path is allowed. */
  readonly active: boolean;
  /** The configured prefixes, normalised. Only meaningful while `active`. */
  readonly prefixes: readonly string[];
}

/**
 * Drops leading and trailing slashes with two counted walks.
 *
 * Not `replace(/\/+$/, '')`: a pattern that starts with a repetition and ends
 * in `$` is tried from every slash of a run and consumes the run each time,
 * which is quadratic in the run. The inputs here are short today — an
 * operator's variable, a 2048-character path — and the walk costs nothing, so
 * the shape is not worth keeping for the day one of them is not.
 */
export function stripSurroundingSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

/** The trailing half of {@link stripSurroundingSlashes}, for a URL path. */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** Longest entry that is still printed as itself rather than described. */
const MAX_PRINTED_PREFIX = 80;

/**
 * A prefix as a diagnostic may print it.
 *
 * `WIKIJS_ALLOWED_PATHS` sits one line below `WIKIJS_TOKEN` in every compose
 * file, and a token pasted into the wrong line is a perfectly valid prefix —
 * no `..`, no `*` — that this server then printed in full at startup and in
 * every scope refusal, which is the model's context. So only something with
 * the shape of a page path is printed; anything else is described by its
 * length. A JWT has the right characters and the wrong length.
 */
export function describePrefix(entry: string): string {
  const pathShaped =
    entry.length <= MAX_PRINTED_PREFIX &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(entry);
  return pathShaped ? entry : `a ${entry.length}-character entry`;
}

/** The configured prefixes, each as {@link describePrefix} prints it. */
export function describeScope(scope: {
  readonly prefixes: readonly string[];
}): string {
  return scope.prefixes.map(describePrefix).join(', ');
}

/** Splits the raw variable the way {@link buildPathScope} does, without judging it. */
function splitPrefixes(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => stripSurroundingSlashes(entry.trim()))
    .filter((entry) => entry.length > 0);
}

/** What the startup line may say about `WIKIJS_ALLOWED_PATHS`. */
export function describeAllowedPaths(raw: string): string {
  return splitPrefixes(raw).map(describePrefix).join(', ');
}

/**
 * Parses `WIKIJS_ALLOWED_PATHS`.
 *
 * An empty or whitespace-only value counts as *unset*: `WIKIJS_ALLOWED_PATHS=`
 * in a compose file must not mean "no path is writable", which would make every
 * write tool fail with a message about a variable the operator thought they had
 * left alone.
 */
export function buildPathScope(raw: string | undefined): PathScope {
  if (raw === undefined) return { active: false, prefixes: [] };
  const prefixes = splitPrefixes(raw);
  if (prefixes.length === 0) return { active: false, prefixes: [] };

  for (const prefix of prefixes) {
    if (prefix.includes('..') || prefix.includes('*')) {
      throw new PathScopeError(
        `WIKIJS_ALLOWED_PATHS: "${quoted(prefix, 40)}" is not a valid prefix — it must be a ` +
          'plain page path such as "docs" or "team/notes", without ".." or wildcards.'
      );
    }
  }
  return { active: true, prefixes };
}

/**
 * True when `path` is inside the scope.
 *
 * Segment-wise, never a bare `startsWith`: with a plain prefix test the scope
 * `docs` would also cover `docs-archive`, which is a different page tree that
 * merely begins with the same letters. This is the same trap the hardening
 * checklist names for URL-prefix allowlists.
 */
export function isWithinScope(scope: PathScope, path: string): boolean {
  if (!scope.active) return true;
  const normalised = stripSurroundingSlashes(path);
  return scope.prefixes.some(
    (prefix) => normalised === prefix || normalised.startsWith(`${prefix}/`)
  );
}

/**
 * Throws unless `path` is inside the scope.
 *
 * Called per tool rather than from a shared helper deep in the API client: the
 * checklist is explicit that a scope enforced in one place is a scope that
 * misses the tool which happens to take a different route to the same write —
 * `move_page` has two paths, and only one of them is the one it was called with.
 */
export function assertWithinScope(
  scope: PathScope,
  path: string,
  role: string
): void {
  if (isWithinScope(scope, path)) return;
  throw new PathScopeError(
    `${role} "${quoted(path, 120)}" is outside WIKIJS_ALLOWED_PATHS. Writes are confined to: ` +
      `${describeScope(scope)}. Reads are not restricted.`
  );
}
