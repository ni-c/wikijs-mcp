# wikijs-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/wikijs-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/wikijs-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Fwikijs-mcp)](https://www.npmjs.com/package/@ni-c/wikijs-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Fwikijs-mcp)](https://www.npmjs.com/package/@ni-c/wikijs-mcp)
[![node](https://img.shields.io/node/v/%40ni-c%2Fwikijs-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Fwikijs-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Fwikijs--mcp-blue)](https://github.com/ni-c/wikijs-mcp/pkgs/container/wikijs-mcp)
[![docs](https://img.shields.io/badge/docs-wikijs--mcp.ni--c.de-informational)](https://wikijs-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

<!-- The opening is three paragraphs in a fixed shape: what it IS, what it LETS A
     CLIENT DO, and how to make it smaller. Keep "Lets MCP clients like Claude Code,
     Claude Desktop or Codex …" verbatim — the family drifted into "It lets an AI
     assistant", "It gives a model" and "This server speaks" before it was pinned.

     There is NO standalone "Full documentation" line. The docs badge above links
     to the same page; the line existed in five different spellings and said
     nothing the badge did not. -->

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[Wiki.js](https://js.wiki), the self-hosted wiki that keeps its pages as markdown and exposes everything through one GraphQL endpoint.

Lets MCP clients like Claude Code, Claude Desktop or Codex search, read and edit wiki pages — and, if you let them, manage its assets, comments, users, groups and maintenance jobs.

Sixty-two tools is the ceiling, not the floor:
`WIKIJS_ALLOW_TOOLS=essential` registers a curated seven
instead, and a model picks the right tool far more reliably from
seven than from sixty-two — see
[choosing which tools load](#choosing-which-tools-load).

<!-- <picture> is resolved against the colour scheme of the page showing it, so GitHub
     picks the variant that matches its own theme toggle. npm strips <picture> and
     <source> when it sanitises the README and keeps the <img>, which is why that
     fallback brings its own dark card instead of relying on a media query.
     All three URLs must stay absolute: npm does not resolve repo-relative paths. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://wikijs-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://wikijs-mcp.ni-c.de/architecture-light.svg">
  <img src="https://wikijs-mcp.ni-c.de/architecture.svg" alt="An MCP client talking to wikijs-mcp over stdio, which calls the Wiki.js GraphQL endpoint" width="800">
</picture>

<!-- Absolute, like the diagram: npm does not resolve repo-relative paths, and a
     recording nobody sees is a recording that was not worth making. -->
<img src="https://wikijs-mcp.ni-c.de/demo.gif" alt="Searching a wiki for text the built-in search cannot find, then being refused an ambiguous edit" width="800">

## Requirements

- Node.js ≥ 22
- A running **Wiki.js** instance and an API token

## Configuration

| Variable               | Required | Description                                                                                |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `WIKIJS_URL`           | yes      | Base URL of the wiki, e.g. `https://wiki.example.com`. A trailing `/graphql` is trimmed    |
| `WIKIJS_TOKEN`         | yes      | API key from Administration → API Access. `WIKIJS_API_KEY` is accepted as an alias         |
| `WIKIJS_LOCALE`        | no       | Locale assumed by page tools that are not given one (default `en`)                         |
| `WIKIJS_READ_ONLY`     | no       | `true` registers only the read tools                                                       |
| `WIKIJS_ALLOWED_PATHS` | no       | Comma-separated page path prefixes the write tools are confined to, e.g. `docs,team/notes` |
| `WIKIJS_ALLOW_TOOLS`   | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset         |
| `WIKIJS_DENY_TOOLS`    | no       | Same syntax; removed from whatever `WIKIJS_ALLOW_TOOLS` left                               |
| `ELICITATION`          | no       | `false` replaces the approval dialog with the two-call token. **Not prefixed**             |
| `WIKIJS_INSECURE_TLS`  | no       | `true` accepts self-signed certificates (scoped to this connection)                        |

**The locale is part of a page's identity**, not a display preference: the same path
under `en` and `de` is two different pages. On a wiki set up in another language,
set `WIKIJS_LOCALE` or every lookup by path answers "not found". `list_locales`
reports what is installed.

**API keys are administrative.** Wiki.js offers "full access" or a group, and a
full-access key can rewrite every page and every account. `WIKIJS_READ_ONLY`,
`WIKIJS_ALLOWED_PATHS` and the key's own group permissions are three independent
ways to narrow that — see [SECURITY.md](SECURITY.md).

> **Use `https://`.** Over plain http the token travels unencrypted; the server
> prints a warning unless the host is local. For self-signed certificates prefer a
> proper internal CA over `WIKIJS_INSECURE_TLS`.

Without credentials the server still starts and lists its tools (so registries and
inspectors can introspect it), but every call fails with setup instructions instead
of reaching the API.

### Choosing which tools load

<!-- This heading is the anchor the opening paragraph links to. Keep the wording:
     it has to be #choosing-which-tools-load in every repository. -->

`WIKIJS_ALLOW_TOOLS` and `WIKIJS_DENY_TOOLS` take comma-separated
tool names; a trailing `*` matches a whole family. `essential` is a curated preset —
`search_pages`, `grep_pages`, `get_page`, `list_pages`, `get_page_tree`, `create_page` and `update_page`, which is what it takes to find, read and write a wiki page end to end — marked as such in the
[tool reference](https://wikijs-mcp.ni-c.de/reference/tools).

```sh
WIKIJS_ALLOW_TOOLS=essential
WIKIJS_ALLOW_TOOLS=get_page,search_pages,list_*
WIKIJS_DENY_TOOLS=delete_*,purge_page_history,set_api_state
```

An entry that matches no tool aborts startup and names it, so a typo cannot silently
hide a tool — an absent tool is not something anyone traces back to an environment
variable. A filtered tool is never registered, so it is absent from `tools/list` and
unknown to `tools/call` alike, exactly like a write tool under
`WIKIJS_READ_ONLY`.

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de) is
the other answer — its `/hub` endpoint replaces every server's tools with six
meta-tools.

### Confining writes to part of the wiki

`WIKIJS_ALLOWED_PATHS` limits the writing page and asset tools to a set of path
prefixes. Reads stay unrestricted, deliberately: a scope on reads turns a wiki into
a confusing half-wiki, and the API key's own page rules are the right place to hide
pages outright — they hide them from the web UI too.

```sh
WIKIJS_ALLOWED_PATHS=docs,team/notes
```

Matching is by path segment, so `docs` covers `docs/setup` and **not**
`docs-archive/old`. `move_page` checks both ends, so a page cannot be moved out of
the allowed area or into a protected one.

Asset writes are checked against the asset folder tree, which is a separate
namespace. The operations that cannot be confined to a prefix at all — the
instance-wide maintenance tools, the tag tools, and comment edits, because
Wiki.js does not say which page a comment is on — refuse while the variable is
set rather than making a silent exception.

## Installation

### Claude Code

```sh
claude mcp add wikijs-mcp -- npx -y @ni-c/wikijs-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "wikijs-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/wikijs-mcp"],
      "env": {
        "WIKIJS_URL": "https://wiki.example.com",
        "WIKIJS_TOKEN": "…"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.wikijs-mcp]
command = "npx"
args = ["-y", "@ni-c/wikijs-mcp"]
env = { WIKIJS_URL = "https://wiki.example.com", WIKIJS_TOKEN = "…" }
```

### Docker

```sh
docker run --rm -i \
  -e WIKIJS_URL=https://wiki.example.com \
  -e WIKIJS_TOKEN=… \
  ghcr.io/ni-c/wikijs-mcp
```

## Tools

62 tools. ★ marks the `essential` preset; ⚠ marks a tool that **asks a person**
through MCP elicitation — a dialog the model cannot answer on its behalf, falling
back to a two-call `confirm_token` where the client cannot show one. See
[Asking a person](https://wikijs-mcp.ni-c.de/guide/approval).

| Tool                       | Description                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_pages`               | ★ Lists pages with their metadata, newest first by default.                                                                                                                         |
| `get_page`                 | ★ Reads one page, addressed by page_id or by path plus locale.                                                                                                                      |
| `search_pages`             | ★ Full-text search — but read this first: on a default Wiki.js the search engine is "Database - Basic", which only indexes page titles and descriptions, NOT the text inside pages. |
| `grep_pages`               | ★ Searches the actual text of pages with a regular expression, by fetching them and matching locally.                                                                               |
| `get_page_tree`            | ★ Lists the pages and folders directly under a path — the structural view a wiki has and a search does not.                                                                         |
| `list_page_links`          | Returns every page together with the internal links it contains — the wiki’s link graph for one locale.                                                                             |
| `create_page`              | ★ Creates a page.                                                                                                                                                                   |
| `update_page`              | ★ Changes a page.                                                                                                                                                                   |
| `move_page`                | Moves a page to another path, another locale, or both.                                                                                                                              |
| `delete_page`              | ⚠ Deletes a page and its history.                                                                                                                                                   |
| `convert_page_editor`      | Changes the storage format of a page.                                                                                                                                               |
| `list_page_history`        | Lists the stored versions of a page, newest first, with who changed what and when.                                                                                                  |
| `get_page_version`         | Returns a single historical version of a page, including its full body as it was then.                                                                                              |
| `diff_page_versions`       | Returns a unified diff between two versions of a page — or between one version and the page as it is now, if to_version is omitted.                                                 |
| `get_page_conflict`        | Returns the version of a page that is newer than the one you read — what update_page points at when it refuses to write.                                                            |
| `restore_page_version`     | Rolls a page back to a stored version.                                                                                                                                              |
| `list_tags`                | Every tag in the wiki, with its display title and when it was last used.                                                                                                            |
| `search_tags`              | Finds tags matching a fragment.                                                                                                                                                     |
| `update_tag`               | Changes a tag’s name or display title across every page carrying it.                                                                                                                |
| `delete_tag`               | ⚠ Removes a tag from the wiki and from every page that carries it.                                                                                                                  |
| `list_assets`              | Lists the images and files in one asset folder.                                                                                                                                     |
| `list_asset_folders`       | Lists the folders directly under an asset folder.                                                                                                                                   |
| `upload_asset`             | Uploads an image or file to an asset folder, so it can be embedded in a page.                                                                                                       |
| `create_asset_folder`      | Creates a folder in the asset store.                                                                                                                                                |
| `rename_asset`             | Renames an asset.                                                                                                                                                                   |
| `delete_asset`             | ⚠ Deletes an asset permanently.                                                                                                                                                     |
| `list_comments`            | Returns the comments on one page, addressed by path and locale — not by page id, which is the one place Wiki.js asks for the path instead.                                          |
| `get_comment`              | Returns a single comment by id, with its source and its rendered HTML.                                                                                                              |
| `create_comment`           | Posts a comment on a page, optionally as a reply to another.                                                                                                                        |
| `update_comment`           | Replaces the body of a comment.                                                                                                                                                     |
| `delete_comment`           | ⚠ Removes a comment permanently.                                                                                                                                                    |
| `list_users`               | Lists the wiki’s user accounts.                                                                                                                                                     |
| `search_users`             | Finds users by name or email.                                                                                                                                                       |
| `get_user`                 | Full detail for one account, including its group memberships and whether two-factor authentication is active.                                                                       |
| `create_user`              | Creates an account.                                                                                                                                                                 |
| `update_user`              | Changes an account’s details or its group membership.                                                                                                                               |
| `delete_user`              | ⚠ Removes an account.                                                                                                                                                               |
| `set_user_active`          | Switches an account on or off.                                                                                                                                                      |
| `verify_user`              | Marks an account’s email as verified, which is otherwise done by the user clicking a link.                                                                                          |
| `set_user_tfa`             | Switches an account’s second factor.                                                                                                                                                |
| `reset_user_password`      | Starts Wiki.js’ own password reset for a local account, which emails the user a link.                                                                                               |
| `list_groups`              | Lists the wiki’s groups with how many users each has.                                                                                                                               |
| `get_group`                | Returns one group with its global permissions, its page rules and its members.                                                                                                      |
| `create_group`             | Creates an empty group.                                                                                                                                                             |
| `update_group`             | Replaces a group’s name, permissions and page rules wholesale — this is not a partial update, and omitting a rule deletes it.                                                       |
| `delete_group`             | ⚠ Removes a group.                                                                                                                                                                  |
| `assign_user_to_group`     | Adds one account to one group, leaving its other memberships alone — the additive counterpart to update_user’s groups list.                                                         |
| `unassign_user_from_group` | Takes one account out of one group.                                                                                                                                                 |
| `get_site_info`            | Version, database, host summary and the site’s own title and description, plus totals for pages, users, groups and tags.                                                            |
| `list_locales`             | Which locales are installed and which one is the default.                                                                                                                           |
| `get_navigation_tree`      | The sidebar navigation as configured, per locale.                                                                                                                                   |
| `list_search_engines`      | Which search engine this wiki uses.                                                                                                                                                 |
| `list_api_keys`            | Lists the wiki’s API keys with their expiry and whether they are revoked, plus whether API access is switched on at all.                                                            |
| `list_storage_targets`     | The configured storage backends — git mirrors, S3 buckets, local file dumps — with their sync status and last error.                                                                |
| `revoke_api_key`           | ⚠ Revokes an API key immediately and for good — Wiki.js has no way to un-revoke one.                                                                                                |
| `set_api_state`            | ⚠ Switches Wiki.js’ whole API on or off.                                                                                                                                            |
| `render_page`              | Forces Wiki.js to regenerate one page’s HTML from its source.                                                                                                                       |
| `flush_page_cache`         | Drops Wiki.js’ rendered-page cache for the whole wiki.                                                                                                                              |
| `rebuild_page_tree`        | Recomputes the folder structure Wiki.js derives from page paths.                                                                                                                    |
| `rebuild_search_index`     | Reindexes every page in the active search engine.                                                                                                                                   |
| `purge_page_history`       | ⚠ Deletes stored page versions older than a cutoff, across the whole wiki.                                                                                                          |
| `migrate_pages_locale`     | ⚠ Moves all pages from one locale to another, across the whole wiki.                                                                                                                |

The full reference, with every parameter, is at
[wikijs-mcp.ni-c.de/reference/tools](https://wikijs-mcp.ni-c.de/reference/tools).

### Two things worth knowing before you use `search_pages`

**Wiki.js' default search engine does not index page content.** "Database - Basic"
matches titles and descriptions only, so searching for a phrase written inside a
page returns nothing at all. `search_pages` reports which engine is active and says
so; `grep_pages` fetches pages and matches their text locally, which is slower and
actually finds things. Switching the wiki to the PostgreSQL or Elasticsearch engine
and running `rebuild_search_index` fixes it properly.

**`update_page` refuses to overwrite somebody else's edit.** It compares the page
against the moment _you_ read it, not against its own read a millisecond earlier,
so an edit saved from the web UI while the model was thinking is caught rather than
silently discarded. `get_page_conflict` shows the newer version; `force: true`
overwrites on purpose.

## Safety

- **Destructive and administrative tools ask a person.** Where the client supports
  MCP elicitation they raise a real dialog that the model cannot answer on its
  behalf. Where it does not, the first call returns a short-lived token bound to the
  exact target and only a second call carrying it performs the operation — which
  proves the call was made twice with the same arguments and nothing more, and the
  text says so. The binding includes everything that decides _what_ is touched — an
  approval for `migrate_pages_locale` from `de` to `en` will not run `en` to `de`.
  `ELICITATION=false` takes the fallback deliberately; it never removes the guard.
- **Three maintenance tools are deliberately not gated.** `flush_page_cache`,
  `rebuild_page_tree` and `rebuild_search_index` cost time, not content. A dialog in
  front of an operation that loses nothing is how people learn to tick without
  reading.
- **Confirmation prompts never quote content from Wiki.js.** Page titles and
  descriptions are written by anyone with edit rights, and that text is read by a
  model. Only ids, paths and server-side values appear, and a path is checked to be
  an identifier before it is interpolated.
- **Returned page content is marked as untrusted data**, because a wiki is exactly
  a place where text is stored to be read later.
- **There is no tool that creates an API key**, although the Wiki.js API offers
  one: a model able to mint a full-access key could grant itself administrative
  access that outlives this session. `list_api_keys` and `revoke_api_key` are here
  so keys can be audited and taken away.
- Credentials are deleted from the environment after startup, secrets in API
  responses are redacted, error bodies are truncated and HTML error pages dropped.
- `WIKIJS_READ_ONLY=true` does not register the write tools at all, and
  `WIKIJS_DENY_TOOLS` cuts finer along the same line — a filtered tool is never
  built, not refused at call time.

## Releasing

1. Add the CHANGELOG entry and bump `package.json`.
2. `npm run lint && npm run build && npm run test:coverage`
3. Commit, then push a signed tag: `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin main vX.Y.Z`

The release workflow publishes to npm (Trusted Publishing, with provenance), creates
the GitHub release from the CHANGELOG section and updates the MCP Registry entry.

## License

MIT © Willi Thiel
