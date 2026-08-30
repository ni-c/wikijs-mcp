<!--
  GENERATED FILE — do not edit by hand.
  Regenerate with: npm run build && npm run docs:tools
  The CI test job fails when this file is out of date.
-->

# Tool reference

All 62 tools: 27 read, 35 write.
With `WIKIJS_READ_ONLY=true` the write tools are not registered at all.

All 62 are registered unless you say otherwise. `WIKIJS_ALLOW_TOOLS`
and `WIKIJS_DENY_TOOLS` narrow the list to the ones you want, and
`WIKIJS_ALLOW_TOOLS=essential` selects the 7 marked **essential**
below — see [choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

Every tool that addresses a page takes either `page_id` or `path` plus
`locale` — the locale is part of a page's identity and defaults to
`WIKIJS_LOCALE`. A tool with a `confirm_token` parameter is two-step: the
first call returns a short-lived token bound to the exact target, and only
a second call carrying that token performs the operation.

## Read tools

### `list_pages`

**List pages** — read-only, **essential**

Lists pages with their metadata, newest first by default. The result reports how many pages matched as well as how many are shown, so a short answer is never mistaken for a small wiki. Wiki.js has no offset for this query, so narrow with tags, locale, creator_id or author_id rather than paging. Returns no page content; use get_page for that.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | no | Maximum number of entries to return (default 50). Wiki.js has no offset for page lists, so narrowing by tags, locale or path beats raising this. |
| `tags` | string[] | no | Only pages carrying all of these tags. |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `creator_id` | integer | no | Only pages originally created by this user id. |
| `author_id` | integer | no | Only pages last edited by this user id. |
| `order_by` | `"TITLE"` \| `"CREATED"` \| `"UPDATED"` \| `"PATH"` \| `"ID"` | no | Sort field (default UPDATED). |
| `direction` | `"ASC"` \| `"DESC"` | no |  |

### `get_page`

**Get a page** — read-only, **essential**

Reads one page, addressed by page_id or by path plus locale. Choose a mode: "metadata" for everything but the text, "outline" for the headings only (cheapest way to see what a long page contains), "content" for the source, "rendered" for the HTML. With mode=content, either pass section to get one heading’s worth, or offset and max_chars to read the page in windows — a large page will otherwise be truncated to fit the result budget.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | no | Numeric Wiki.js id. |
| `path` | string | no | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `mode` | `"metadata"` \| `"outline"` \| `"content"` \| `"rendered"` | no | What to return (default "content"). |
| `section` | string | no | With mode=content: return only the section under this heading, including its subsections. Refuses an ambiguous heading rather than guessing. |
| `offset` | integer | no | With mode=content: character offset to start at. |
| `max_chars` | integer | no | With mode=content: how much to return (default 20000). |

### `search_pages`

**Search pages** — read-only, **essential**

Full-text search — but read this first: on a default Wiki.js the search engine is "Database - Basic", which only indexes page titles and descriptions, NOT the text inside pages. The result names the active engine so you can tell. If the engine is basic and you are looking for something written inside a page, use grep_pages instead. Results carry no excerpt; follow up with get_page.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Search terms. |
| `path` | string | no | Restrict to this path prefix. |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `limit` | integer | no | Maximum number of entries to return (default 50). Wiki.js has no offset for page lists, so narrowing by tags, locale or path beats raising this. |

### `grep_pages`

**Search inside page text** — read-only, **essential**

Searches the actual text of pages with a regular expression, by fetching them and matching locally. This exists because Wiki.js’ default search engine does not index page content at all. It is the expensive path — one request per page — so narrow it with path_prefix, tags or locale, and keep max_pages small. Returns matching lines with context, not whole pages.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pattern` | string | yes | JavaScript regular expression, matched against page content. |
| `ignore_case` | boolean | no | Case-insensitive matching (default true). |
| `path_prefix` | string | no | Only pages whose path starts with this prefix. |
| `tags` | string[] | no |  |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `max_pages` | integer | no | How many pages to fetch at most (default 60). |
| `context_lines` | integer | no | Lines of context around each match (default 1). |

### `get_page_tree`

**Browse the page tree** — read-only, **essential**

Lists the pages and folders directly under a path — the structural view a wiki has and a search does not. mode "ALL" returns both folders and pages, "FOLDERS" only folders, "PAGES" only pages. Wiki.js offers no limit on this query, so a very wide level is truncated to the result budget.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | no | Parent path. Omit for the root of the wiki. |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `mode` | `"ALL"` \| `"FOLDERS"` \| `"PAGES"` | no |  |
| `include_ancestors` | boolean | no | Also return the path from the root down to this level. |

### `list_page_links`

**List internal links** — read-only

Returns every page together with the internal links it contains — the wiki’s link graph for one locale. Useful for finding what would break before moving or deleting a page. Wiki.js returns the whole graph at once and offers no filter, so on a large wiki this is truncated.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |

### `list_page_history`

**List a page’s history** — read-only

Lists the stored versions of a page, newest first, with who changed what and when. This is the one Wiki.js query that really paginates. The version ids here are what get_page_version, diff_page_versions and restore_page_version take.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | no | Numeric Wiki.js id. |
| `path` | string | no | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `page` | integer | no | Zero-based page of results (default 0). |
| `page_size` | integer | no | Entries per page (default 50). |

### `get_page_version`

**Get one stored version** — read-only

Returns a single historical version of a page, including its full body as it was then. To find out what changed between two versions, diff_page_versions is far cheaper than reading both.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | yes | Numeric Wiki.js id. |
| `version_id` | integer | yes | Version id from list_page_history. |

### `diff_page_versions`

**Compare two versions** — read-only

Returns a unified diff between two versions of a page — or between one version and the page as it is now, if to_version is omitted. Answers "what changed here" in one call instead of two full page bodies.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | yes | Numeric Wiki.js id. |
| `from_version` | integer | yes | The older version id, from list_page_history. |
| `to_version` | integer | no | The newer version id. Omit to compare against the live page. |
| `context_lines` | integer | no | Unchanged lines shown around each change (default 3). |

### `get_page_conflict`

**Get the newer version behind a conflict** — read-only

Returns the version of a page that is newer than the one you read — what update_page points at when it refuses to write. Shows who saved it and when, so the change can be redone on top instead of discarded.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | yes | Numeric Wiki.js id. |

### `list_tags`

**List all tags** — read-only

Every tag in the wiki, with its display title and when it was last used. Tags are the one cross-cutting index a wiki has, so this is often a better starting point than search — feed a tag back into list_pages to see what carries it.

Takes no parameters.

### `search_tags`

**Search tags** — read-only

Finds tags matching a fragment. Cheaper than list_tags on a wiki with hundreds of them, and the usual way to check what a tag is actually called before filtering list_pages by it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Fragment to match against tag names. |

### `list_assets`

**List assets in a folder** — read-only

Lists the images and files in one asset folder. Folder 0 is the root. Assets are flat within a folder and Wiki.js has no search across them, so finding one means walking list_asset_folders.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `folder_id` | unknown | no | Folder id from list_asset_folders. 0 (default) is the root. |
| `kind` | `"ALL"` \| `"IMAGE"` \| `"BINARY"` | no | Restrict to images or to non-image files. |

### `list_asset_folders`

**List asset folders** — read-only

Lists the folders directly under an asset folder. Folder 0 is the root. Wiki.js returns one level at a time, so a deep tree needs one call per level.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `parent_folder_id` | unknown | no | Parent folder id. 0 (default) is the root. |

### `list_comments`

**List comments on a page** — read-only

Returns the comments on one page, addressed by path and locale — not by page id, which is the one place Wiki.js asks for the path instead. An empty list can also mean comments are switched off for the wiki; get_site_info reports that.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |

### `get_comment`

**Get one comment** — read-only

Returns a single comment by id, with its source and its rendered HTML.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `comment_id` | integer | yes | Numeric Wiki.js id. |

### `list_users`

**List users** — read-only

Lists the wiki’s user accounts. `providerKey` says how they log in — "local" for a Wiki.js password, anything else for an identity provider. Email addresses are returned because they are the login.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filter` | string | no | Substring filter over name and email. |
| `order_by` | `"id"` \| `"email"` \| `"name"` \| `"createdAt"` \| `"updatedAt"` | no |  |
| `limit` | integer | no | Maximum number of entries to return (default 50). Wiki.js has no offset for page lists, so narrowing by tags, locale or path beats raising this. |

### `search_users`

**Search users** — read-only

Finds users by name or email. Use it to resolve a person to the id that list_pages (creator_id, author_id) and the group tools take.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Name or email fragment. |

### `get_user`

**Get a user** — read-only

Full detail for one account, including its group memberships and whether two-factor authentication is active. No credential of any kind is returned — Wiki.js does not expose one.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `user_id` | integer | yes | Numeric Wiki.js id. |

### `list_groups`

**List groups** — read-only

Lists the wiki’s groups with how many users each has. Groups marked isSystem are Wiki.js’ own Administrators and Guests — they exist always and should not be deleted.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filter` | string | no |  |
| `order_by` | `"id"` \| `"name"` \| `"createdAt"` \| `"updatedAt"` | no |  |

### `get_group`

**Get a group** — read-only

Returns one group with its global permissions, its page rules and its members. This is the authoritative answer to "who can see or edit what" — and it is what update_group needs as its starting point, because that mutation replaces the whole rule set.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `group_id` | integer | yes | Numeric Wiki.js id. |

### `get_site_info`

**Get site and system information** — read-only

Version, database, host summary and the site’s own title and description, plus totals for pages, users, groups and tags. The first call to make when something is not behaving — it proves the URL and the API key work at all. Fields describing the host filesystem and database host are deliberately not requested.

Takes no parameters.

### `list_locales`

**List locales** — read-only

Which locales are installed and which one is the default. Worth checking once per wiki: the locale is part of a page’s identity, and every page tool here falls back to WIKIJS_LOCALE, so a wiki running on "de" needs that set or nothing will be found.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `installed_only` | boolean | no | Only locales actually installed (default true). Wiki.js lists every locale it could download otherwise — over a hundred. |

### `get_navigation_tree`

**Get the navigation menu** — read-only

The sidebar navigation as configured, per locale. This is curated by hand and is not the page tree — get_page_tree is what reflects the pages that actually exist.

Takes no parameters.

### `list_search_engines`

**List search engines** — read-only

Which search engine this wiki uses. Worth knowing before trusting search_pages: the default "Database - Basic" indexes only titles and descriptions, so nothing written inside a page is searchable until a real engine is configured and the index rebuilt.

Takes no parameters.

### `list_api_keys`

**List API keys** — read-only

Lists the wiki’s API keys with their expiry and whether they are revoked, plus whether API access is switched on at all. Wiki.js stores only a truncated form of each key and never returns the secret, so nothing here can be used to authenticate.

Takes no parameters.

### `list_storage_targets`

**List storage targets** — read-only

The configured storage backends — git mirrors, S3 buckets, local file dumps — with their sync status and last error. Credentials in their configuration are redacted.

Takes no parameters.

## Write tools

### `create_page`

**Create a page** — write, **essential**

Creates a page. The path must not already exist in this locale — Wiki.js answers PageDuplicateCreate otherwise, and update_page is what changes an existing one. The editor decides how content is interpreted, so markdown source needs editor="markdown".

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `title` | string | yes | Page title as shown in the wiki. |
| `content` | string | yes | Full page body, in the page’s content format. |
| `description` | string | no | Short page description, shown in listings and search results. |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `tags` | string[] | no |  |
| `editor` | `"markdown"` \| `"ckeditor"` \| `"code"` \| `"asciidoc"` | no | Storage format. "markdown" for markdown source, "ckeditor" for rich-text HTML, "code" for raw HTML, "asciidoc" for AsciiDoc. |
| `is_published` | boolean | no | Publish immediately (default true). False creates a draft. |
| `is_private` | boolean | no |  |

### `update_page`

**Update a page** — write, **essential**

Changes a page. Pass content to replace the whole body, or edits for surgical find-and-replace — each edit’s old_text must appear exactly once, and an ambiguous or missing match is refused rather than applied to the wrong place. Before writing, this checks whether somebody else changed the page since it was read and refuses to clobber them; pass force=true to overwrite deliberately. Metadata fields can be changed on their own, without touching the text.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | no | Numeric Wiki.js id. |
| `path` | string | no | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `content` | string | no | Replacement body. Mutually exclusive with edits. |
| `edits` | object[] | no | Find-and-replace edits. Mutually exclusive with content. |
| `title` | string | no | Page title as shown in the wiki. |
| `description` | string | no | Short page description, shown in listings and search results. |
| `tags` | string[] | no | Replaces the whole tag list, it is not merged. |
| `is_published` | boolean | no |  |
| `is_private` | boolean | no |  |
| `editor` | `"markdown"` \| `"ckeditor"` \| `"code"` \| `"asciidoc"` | no | Storage format. "markdown" for markdown source, "ckeditor" for rich-text HTML, "code" for raw HTML, "asciidoc" for AsciiDoc. |
| `expected_updated_at` | string | no | The updatedAt value you saw when you read this page. Normally unnecessary — a previous get_page in this session is remembered automatically — but it makes the concurrent-edit check work without one. |
| `force` | boolean | no | Write even though the page changed since you read it. Overwrites the other person’s edit. |

### `move_page`

**Move or rename a page** — write

Moves a page to another path, another locale, or both. Internal links pointing at the old path are NOT rewritten by Wiki.js — check list_page_links first if that matters.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | no | Numeric Wiki.js id. |
| `path` | string | no | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `destination_path` | string | yes | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `destination_locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `delete_page`

**Delete a page** — write, destructive

Deletes a page and its history. Wiki.js has no trash — this cannot be undone from here. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | no | Numeric Wiki.js id. |
| `path` | string | no | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `convert_page_editor`

**Convert a page to another editor** — write

Changes the storage format of a page. Wiki.js does not translate the body — converting markdown to "code" leaves the markdown source as raw HTML text. Use it to correct a page created with the wrong editor, not to reformat one.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | no | Numeric Wiki.js id. |
| `path` | string | no | Page path without a leading slash and without the locale prefix, e.g. "docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are perfectly good first segments that happen to look like locale codes.) |
| `locale` | string | no | Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity. |
| `editor` | `"markdown"` \| `"ckeditor"` \| `"code"` \| `"asciidoc"` | yes | Storage format. "markdown" for markdown source, "ckeditor" for rich-text HTML, "code" for raw HTML, "asciidoc" for AsciiDoc. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `restore_page_version`

**Restore an earlier version** — write, destructive

Rolls a page back to a stored version. The current content is not lost — it becomes another entry in the history — but the live page is replaced. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | yes | Numeric Wiki.js id. |
| `version_id` | integer | yes | Version id from list_page_history. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `update_tag`

**Rename a tag** — write

Changes a tag’s name or display title across every page carrying it. Renaming affects all of them at once, which is the point and also the risk, so it needs a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tag_id` | integer | yes | Tag id from list_tags. |
| `tag` | string | yes | New tag name. |
| `title` | string | yes | New display title. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `delete_tag`

**Delete a tag** — write, destructive

Removes a tag from the wiki and from every page that carries it. The pages themselves are untouched. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tag_id` | integer | yes | Tag id from list_tags. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `upload_asset`

**Upload a file** — write

Uploads an image or file to an asset folder, so it can be embedded in a page. Content is passed base64-encoded and the content type is derived from the extension. SVG, HTML and XML are refused: Wiki.js serves assets from the wiki’s own origin, so those can carry script that runs for every reader. Note that Wiki.js 2.x has no GraphQL mutation for uploads at all — this uses the editor’s own route, which is undocumented and could change in a future Wiki.js release.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filename` | string | yes | File name including its extension, e.g. "diagram.png". |
| `content_base64` | string | yes | File contents, base64-encoded. |
| `folder_id` | unknown | no | Target folder id. 0 (default) is the root. |

### `create_asset_folder`

**Create an asset folder** — write

Creates a folder in the asset store. The slug is what appears in the URL of every file inside it.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `parent_folder_id` | unknown | no | Parent folder id. 0 (default) is the root. |
| `slug` | string | yes | URL segment for the folder. |
| `name` | string | no | Display name (defaults to the slug). |

### `rename_asset`

**Rename a file** — write

Renames an asset. Pages embedding it by its old URL will break — Wiki.js does not rewrite them.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `asset_id` | integer | yes | Asset id from list_assets. |
| `filename` | string | yes | New file name, including extension. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `delete_asset`

**Delete a file** — write, destructive

Deletes an asset permanently. Any page embedding it will show a broken image or a dead link. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `asset_id` | integer | yes | Asset id from list_assets. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `create_comment`

**Post a comment** — write

Posts a comment on a page, optionally as a reply to another. The comment is attributed to the account the API key belongs to, which is usually a service account rather than a person — say so in the text if that matters.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | yes | Page id the comment belongs to. |
| `content` | string | yes | Comment body, in markdown. |
| `reply_to` | integer | no | Comment id this replies to. |

### `update_comment`

**Edit a comment** — write, destructive

Replaces the body of a comment. Wiki.js keeps no history for comments, so the previous text is gone.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `comment_id` | integer | yes | Numeric Wiki.js id. |
| `content` | string | yes | Comment body, in markdown. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `delete_comment`

**Delete a comment** — write, destructive

Removes a comment permanently. Replies to it are not removed with it. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `comment_id` | integer | yes | Numeric Wiki.js id. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `create_user`

**Create a user** — write

Creates an account. For a local account supply a password, or set send_welcome_email so Wiki.js mails an invitation instead. Groups are given by id — list_groups has them, and an account in no group can log in but see nothing.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | yes | Email address, which is also the login for local accounts. |
| `name` | string | yes | Display name. |
| `password` | string | no | Initial password for a local account. Never echoed back by this server. |
| `provider_key` | string | no | Authentication provider (default "local"). |
| `groups` | integer[] | no | Group ids to put the account in. |
| `must_change_password` | boolean | no |  |
| `send_welcome_email` | boolean | no |  |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `update_user`

**Update a user** — write

Changes an account’s details or its group membership. The groups list replaces the existing one rather than adding to it — use assign_user_to_group for a single addition.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `email` | string | no | Email address, which is also the login for local accounts. |
| `name` | string | no |  |
| `groups` | integer[] | no | Replaces the whole group list. |
| `location` | string | no |  |
| `job_title` | string | no |  |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `delete_user`

**Delete a user** — write, destructive

Removes an account. Wiki.js needs somebody to inherit the pages it authored, so replace_with_user_id is required — pass the id of the account that should own them afterwards. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `replace_with_user_id` | integer | yes | Account that inherits the deleted user’s pages. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `set_user_active`

**Activate or deactivate a user** — write

Switches an account on or off. A deactivated account keeps its pages and groups but cannot sign in — the reversible alternative to delete_user. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `active` | boolean | yes | True to activate, false to deactivate. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `verify_user`

**Mark a user as verified** — write

Marks an account’s email as verified, which is otherwise done by the user clicking a link. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `set_user_tfa`

**Turn two-factor authentication on or off** — write

Switches an account’s second factor. Turning it OFF weakens that account and is the reason this is gated; turning it on forces the user to enrol at their next sign-in. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `enabled` | boolean | yes | True to require 2FA, false to remove it. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `reset_user_password`

**Reset a user’s password** — write

Starts Wiki.js’ own password reset for a local account, which emails the user a link. No password is chosen or returned here. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `create_group`

**Create a group** — write

Creates an empty group. It starts with no permissions and no page rules, so it grants nothing until update_group is called.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Group name. |

### `update_group`

**Update a group’s permissions** — write

Replaces a group’s name, permissions and page rules wholesale — this is not a partial update, and omitting a rule deletes it. Read the group with get_group first and send back the full set with your change applied. Requires a confirmation token, because this is the call that decides who can read and edit the wiki.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `group_id` | integer | yes | Numeric Wiki.js id. |
| `name` | string | yes |  |
| `permissions` | string[] | yes | Global permissions, e.g. ["read:pages","write:pages"]. Replaces the existing list. |
| `page_rules` | object[] | yes | Complete page rule set. Replaces the existing one. |
| `redirect_on_login` | string | no | Where members land after signing in (default "/"). |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `delete_group`

**Delete a group** — write, destructive

Removes a group. Its members keep their accounts but lose whatever access the group gave them. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `group_id` | integer | yes | Numeric Wiki.js id. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `assign_user_to_group`

**Add a user to a group** — write

Adds one account to one group, leaving its other memberships alone — the additive counterpart to update_user’s groups list. Requires a confirmation token, because a group is what grants access.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `group_id` | integer | yes | Numeric Wiki.js id. |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `unassign_user_from_group`

**Remove a user from a group** — write, destructive

Takes one account out of one group. Requires a confirmation token — removing somebody from their only group leaves them able to sign in and see nothing.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `group_id` | integer | yes | Numeric Wiki.js id. |
| `user_id` | integer | yes | Numeric Wiki.js id. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `revoke_api_key`

**Revoke an API key** — write, destructive

Revokes an API key immediately and for good — Wiki.js has no way to un-revoke one. Note that this can revoke the key this server is using, which would cut its own connection. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `key_id` | integer | yes | Key id from list_api_keys. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `set_api_state`

**Turn the API on or off** — write, destructive

Switches Wiki.js’ whole API on or off. Turning it off disables every API key at once, including this server’s — after which the only way back is the web administration UI. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | yes | True to enable the API, false to disable it. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `render_page`

**Re-render a page** — write

Forces Wiki.js to regenerate one page’s HTML from its source. The fix for a page whose rendering is stale after a theme or renderer change. Changes no content and cannot lose anything.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page_id` | integer | yes | Numeric Wiki.js id. |

### `flush_page_cache`

**Flush the page cache** — write

Drops Wiki.js’ rendered-page cache for the whole wiki. Nothing is lost, but every page has to be rendered again on first access, so a busy instance gets slower for a while. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `rebuild_page_tree`

**Rebuild the page tree** — write

Recomputes the folder structure Wiki.js derives from page paths. The repair for a navigation tree that disagrees with the pages actually present, usually after a bulk import or a database edit. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `rebuild_search_index`

**Rebuild the search index** — write

Reindexes every page in the active search engine. Required once after switching away from "Database - Basic", because the new engine starts empty and search silently returns nothing until this runs. On the basic engine it does nothing. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `purge_page_history`

**Purge old page versions** — write, destructive

Deletes stored page versions older than a cutoff, across the whole wiki. The versions are gone permanently — this is the one maintenance operation that destroys data. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `older_than` | `"P1D"` \| `"P1M"` \| `"P3M"` \| `"P6M"` \| `"P1Y"` \| `"P2Y"` \| `"P3Y"` | yes | ISO-8601 duration cutoff, as Wiki.js’ own admin UI offers: P1D (a day), P1M, P3M, P6M, P1Y, P2Y, P3Y. Versions older than this are deleted. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |

### `migrate_pages_locale`

**Move every page to another locale** — write, destructive

Moves all pages from one locale to another, across the whole wiki. The usual reason is a wiki set up under the wrong locale code. Every page path changes, so every external link into the wiki breaks. Requires a confirmation token.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `source_locale` | string | yes | Locale to move pages out of. |
| `target_locale` | string | yes | Locale to move pages into. |
| `confirm_token` | string | no | Token from this tool’s previous, unconfirmed call. Omit it to receive one. |
