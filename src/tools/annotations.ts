/**
 * The annotation blocks this server's tools carry.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * The line this family draws for `destructiveHint`:
 *
 *   **Content that a person wrote, replaced with no way back — destructive.**
 *   **A setting, a state or a marker, changed — not destructive.**
 *
 * A wiki bends that line in one direction and it is worth naming: Wiki.js keeps
 * page history, so editing a page is recoverable and `update_page` is not
 * destructive — while `update_comment` is, because comments have no history at
 * all. The same verb, opposite answers, decided by what the store remembers.
 *
 * The maintenance tools — `flush_page_cache`, `rebuild_page_tree`,
 * `rebuild_search_index`, `render_page` — rebuild something derived. They lose
 * nothing by construction, which is also why they stop asking for confirmation
 * in this pass.
 *
 * `openWorldHint: false`: this server talks to the one Wiki.js it is configured
 * for.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** A write that adds or amends without losing anything. */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** A write that names an absolute target state and lands on it. */
export const WRITE_IDEMPOTENT = {
  ...WRITE,
  idempotentHint: true,
} as const;

/** A write that replaces or removes something a person put there. */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  // Every destructive tool here names an absolute target — a page id, a tag,
  // a user. Repeating the call leaves the same world; the second one merely
  // fails, which the specification does not count.
  idempotentHint: true,
  openWorldHint: false,
} as const;
