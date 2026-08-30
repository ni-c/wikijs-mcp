/**
 * The declared tool surface.
 *
 * Hard-coded rather than derived from what was registered, and that is the
 * point: the tool filter has to answer "is this a name you have?" *before*
 * anything is registered, and under `WIKIJS_READ_ONLY` the write tools never
 * reach `registerTool` at all. A catalogue built from reality would report
 * "unknown tool" for `delete_page` in read-only mode, which is the one answer
 * that is wrong — it exists, and read-only suppresses it.
 *
 * `test/tool-filter.test.ts` compares this against the server that is actually
 * built, which is also why the tests must not keep a second copy of the names.
 */

export const READ_TOOLS = [
  // Pages
  'list_pages',
  'get_page',
  'search_pages',
  'grep_pages',
  'get_page_tree',
  'list_page_links',
  // History
  'list_page_history',
  'get_page_version',
  'diff_page_versions',
  'get_page_conflict',
  // Tags
  'list_tags',
  'search_tags',
  // Assets
  'list_assets',
  'list_asset_folders',
  // Comments
  'list_comments',
  'get_comment',
  // Users
  'list_users',
  'search_users',
  'get_user',
  // Groups
  'list_groups',
  'get_group',
  // System
  'get_site_info',
  'list_locales',
  'get_navigation_tree',
  'list_search_engines',
  'list_api_keys',
  'list_storage_targets',
] as const;

export const WRITE_TOOLS = [
  // Pages
  'create_page',
  'update_page',
  'move_page',
  'delete_page',
  'convert_page_editor',
  'restore_page_version',
  // Maintenance
  'purge_page_history',
  'render_page',
  'flush_page_cache',
  'rebuild_page_tree',
  'migrate_pages_locale',
  'rebuild_search_index',
  // Tags
  'update_tag',
  'delete_tag',
  // Assets
  'upload_asset',
  'create_asset_folder',
  'rename_asset',
  'delete_asset',
  // Comments
  'create_comment',
  'update_comment',
  'delete_comment',
  // Users
  'create_user',
  'update_user',
  'delete_user',
  'set_user_active',
  'verify_user',
  'set_user_tfa',
  'reset_user_password',
  // Groups
  'create_group',
  'update_group',
  'delete_group',
  'assign_user_to_group',
  'unassign_user_from_group',
  // System
  'revoke_api_key',
  'set_api_state',
] as const;

export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * The `essential` preset: what it takes to find, read and write a wiki page,
 * end to end, and nothing else.
 *
 * Seven names rather than thirty is the whole point — a model picks the right
 * tool far more reliably from a handful, and every visible tool costs context on
 * every single request.
 *
 * `grep_pages` earns its place because on a default Wiki.js the search engine
 * is "Database - Basic", which only indexes titles and descriptions: without it
 * the preset cannot find a page by anything written *in* it, which is most of
 * what anyone asks a wiki. `get_page_tree` is here because a wiki is a
 * hierarchy and "what is under docs/" is not a search.
 *
 * Deliberately absent: everything irreversible (`delete_page`, `move_page`),
 * everything administrative (users, groups, API keys, maintenance), and
 * `diff_page_versions`, which is valuable but answers a question nobody asks
 * until they already have the page. "The read tools" is already
 * `WIKIJS_READ_ONLY` and would add nothing.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'search_pages',
  'grep_pages',
  'get_page',
  'list_pages',
  'get_page_tree',
  'create_page',
  'update_page',
];
