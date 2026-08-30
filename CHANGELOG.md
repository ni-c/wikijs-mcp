# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- The docs site includes everything between these markers. Keep the end marker
     last in the file so the link definitions come along. -->
<!-- #region changelog -->

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
