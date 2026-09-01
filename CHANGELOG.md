# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

## [Unreleased]

### Added

- Tools that need a confirmation now **ask the user**, on clients that can show
  a prompt. The two-call `confirm_token` remains for clients that cannot, so
  nothing that works today stops working — but where a person can be asked, one
  is, instead of a token that only proves the same call was made twice.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**, where the `WIKIJS_*` booleans beside it fail _off_ on a
  typo: this is the only variable here that defaults to _on_. It is read after
  `WIKIJS_TOKEN` and `WIKIJS_API_KEY` are wiped from the environment, so that exit
  cannot leave a credential behind.

- A `docs/guide/approval.md` page, and a 👤 marker in the generated tool
  reference that is read off the registered schema rather than from a list kept
  beside it.

### Removed

- **`flush_page_cache`, `rebuild_page_tree` and `rebuild_search_index` no longer
  ask for a confirmation**, and no longer declare `confirm_token` at all — a
  caller that still sends one gets a schema error rather than silence.

  They were gated because they are instance-wide and slow, and that is the wrong
  argument: nothing is lost by any of them. The cost is time, not content, and a
  dialog in front of an operation that loses nothing is how people learn to tick
  without reading — which spends exactly the attention `purge_page_history`
  needs. What each of them does cost is now stated in its description.

### Changed

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it, and it is what lets
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which
  lifts the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1,
  so this repository was held on TypeScript 6 by its linter rather than by its
  code.

- The tool filter, the confirmation store and the documentation-asset generator
  now come from **`mcp-tool-allowlist`**, **`mcp-approval`** and
  **`svg-asset-set`** rather than from copies kept here — 571 fewer lines, and
  one place to fix each. None of them has a runtime dependency of its own.

### Fixed

- An entry in `WIKIJS_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back. `WIKIJS_API_KEY` and
  `WIKIJS_ALLOW_TOOLS` are adjacent lines in every compose file, and a paste
  into the wrong one used to print the credential into the client's log.

## [0.1.2] - 2026-08-30

### Fixed

- **The container and documentation badges rendered as broken images.** Both were
  mis-escaped: shields.io reads a literal hyphen as a field separator, so
  `ghcr.io-ni--c%2Fwikijs-mcp-blue` splits in the wrong place and the endpoint
  answers 404. The `ni--c` half was escaped correctly in both, which is what made
  it easy to miss. This release is what carries the fix to the package page —
  a README only reaches npmjs.com with a publish.

- **The issue forms shipped with their template placeholders unresolved.** All
  three contact links pointed at `github.com/ni-c/{{REPO}}/…`, so both "Question
  or discussion" and "Report a vulnerability privately" led to a 404 — the second
  being the one that matters, since the alternative a reporter reaches for is a
  public issue. The forms also asked for a "{{REPO}} version" and a
  "{{TARGET_SYSTEM}} API endpoint"; they now name wikijs-mcp, Wiki.js and its
  GraphQL schema.

## [0.1.1] - 2026-08-30

### Fixed

- `list_pages` and `grep_pages` returned far fewer pages than asked for, with
  nothing saying so. Wiki.js' `pages.list` joins the tag table and applies
  `limit` to the **joined rows**, not to the pages — a page with three tags
  eats three of them — so asking for 50 on a 62-page wiki returned between 13
  and 23 depending on the sort order. A short answer was indistinguishable
  from a small wiki. Both tools now bound the list themselves, and `list_pages`
  reports how many pages matched as well as how many are shown.
- The demo recording is now actually shown in the README and on the
  documentation home page. It was recorded and checked in, and nothing
  referenced it.

## [0.1.0] - 2026-08-30

### Added

- Initial release: MCP server for Wiki.js 2.x, with 62 tools covering pages,
  history, tags, assets, comments, users, groups, system settings and
  maintenance.
- `grep_pages`, which searches the actual text of pages. Wiki.js' default
  search engine ("Database - Basic") indexes only titles and descriptions, so
  `search_pages` cannot find anything written _inside_ a page — it now reports
  which engine is active and says so.
- A concurrent-edit guard on `update_page`. It compares against the moment the
  caller read the page, refuses to overwrite somebody else's save, and can be
  overridden deliberately with `force`.
- Surgical edits: `update_page` takes `edits` with a find-and-replace contract
  that requires each anchor to match exactly once, rather than silently editing
  the first occurrence.
- `get_page` modes for metadata, an outline, a named section, and a character
  window, so a large page can be read without filling the context.
- `diff_page_versions`, a unified diff between two stored versions or between a
  version and the live page.
- `upload_asset`, which Wiki.js 2.x has no GraphQL mutation for.
- `WIKIJS_ALLOWED_PATHS`, confining the writing tools to page path prefixes,
  matched by path segment.
- `WIKIJS_READ_ONLY`, `WIKIJS_ALLOW_TOOLS` / `WIKIJS_DENY_TOOLS` with an
  `essential` preset, and confirmation tokens on every destructive or
  administrative operation.

<!-- #endregion changelog -->
