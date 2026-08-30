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
 * Parses `WIKIJS_ALLOWED_PATHS`.
 *
 * An empty or whitespace-only value counts as *unset*: `WIKIJS_ALLOWED_PATHS=`
 * in a compose file must not mean "no path is writable", which would make every
 * write tool fail with a message about a variable the operator thought they had
 * left alone.
 */
export function buildPathScope(raw: string | undefined): PathScope {
  if (raw === undefined) return { active: false, prefixes: [] };
  const prefixes = raw
    .split(',')
    .map((entry) => entry.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0);
  if (prefixes.length === 0) return { active: false, prefixes: [] };

  for (const prefix of prefixes) {
    if (prefix.includes('..') || prefix.includes('*')) {
      throw new PathScopeError(
        `WIKIJS_ALLOWED_PATHS: "${prefix}" is not a valid prefix — it must be a ` +
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
  const normalised = path.replace(/^\/+/, '').replace(/\/+$/, '');
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
    `${role} "${path}" is outside WIKIJS_ALLOWED_PATHS. Writes are confined to: ` +
      `${scope.prefixes.join(', ')}. Reads are not restricted.`
  );
}
