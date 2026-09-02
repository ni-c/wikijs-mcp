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

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result —
  which twenty-nine of them made unavoidable, since they answered with a
  sentence. The sentence stays, in the text block.

  The tools that report wiki content carry `untrusted: true` and
  `source: "wikijs"` as fields, not only as a preamble in the text. Page text,
  titles, descriptions and comments are written by anyone with edit rights, so a
  client that reads the structured half must not get them unframed. The list
  follows the call sites: a tool is marked exactly when it already routed its
  answer through the untrusted wrapper.

  Wiki.js records are described as open objects with the top-level keys this
  server builds. A self-hosted Wiki.js is any 2.x release, and a strict shape
  would turn a field one adds into a tool that fails outright.

### Changed

- `update_page`'s stale-read refusal answers `{page_id, written: false,
conflict: {you_saw, it_is_now}, note}` in addition to its sentence. It is
  still **not** an error result — an `isError` would make a client surface it
  as a failure, when what it is is an instruction for recovering.

- A result too large to shrink is now an error rather than an envelope saying
  so. The envelope was a different shape from what the tool declares it
  returns, which the SDK refuses.

- The two-call `confirm_token` prompt is an error result. What was asked for did
  not happen, which is what `isError` says. The text is unchanged and still
  carries the token.

- The integration compose file publishes Wiki.js on `WIKIJS_PORT` (default 3010) instead of a hardcoded 3010, so a workstation that already runs
  something there does not need a patched compose file.

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

- `WIKIJS_READ_ONLY` now accepts `1` and `yes` as well as `true`, trimmed and
  case-insensitively. `WIKIJS_INSECURE_TLS` deliberately still takes only the
  exact word: a switch that **adds** a protection should honour anything an
  operator plausibly meant by "on", and one that **removes** a protection should
  not.

### Fixed

- **A confirmation for `update_group` did not cover the group's name or its login
  redirect**, although the mutation replaces both. A token issued for a change to
  the page rules would execute a call that also renamed the group — to
  "Administrators", say, which is what every administration view and every later
  `list_groups` answer then reports — and repointed `redirectOnLogin`, where
  Wiki.js sends a member once it has authenticated them. Both are now bound, and
  named in the prompt. `create_user` had the same gap for `password`,
  `provider_key`, `must_change_password` and `send_welcome_email`.

  Found by reading; kept out by `test/confirmation-binding.test.ts`, which varies
  every argument of every gated tool in turn and requires the token to break —
  and which fails when a gated tool gains an argument nobody accounted for.

- **A refusal written by Wiki.js itself went into the model's context unbounded
  and unmarked.** `responseResult.message` is as far upstream as a database
  driver — a comment with a null `replyTo` comes back with the whole INSERT
  statement in it — and that one error path skipped the 2000-character cap the
  other three go through. It is capped now, and set off under a line saying the
  upstream wrote it, rather than folded into this server's own sentence. The
  error slug is reduced to the shape a slug has, so it cannot open a line of its
  own beside that marker.

- **`grep_pages` applied `path_prefix` after the 200-page ceiling instead of
  before it.** On a wiki whose most recently updated pages are all under `blog/`,
  a search under `docs/` answered "0 pages scanned, 0 matched" without reading a
  single one of the pages that did match. The ceiling exists to bound the fetch,
  so it now applies to the pages that survive the filter; the accompanying note
  counts those too, since that is the number a caller can act on.

- **`identifier()` let the bidi control characters through**, including
  RIGHT-TO-LEFT OVERRIDE. Its rule listed four invisible characters and the class
  has rather more, so `move_page` would show a destination path that rendered
  backwards from the one it was about to write. The rule is now stated as the
  Unicode categories it always meant (`Cc`, `Cf`, `Zl`, `Zp`, `Zs`) rather than
  as a list of code points.

- **`WIKIJS_ALLOWED_PATHS` did not cover four of the tools the documentation said
  it covered.** `flush_page_cache`, `rebuild_page_tree` and
  `rebuild_search_index` act on every page in the wiki and now refuse while the
  variable is set, like the two destructive maintenance tools already did — they
  lose nothing, but "the whole wiki" is outside any prefix. And `render_page` is
  now placed against the prefix like every other page write: it changes no
  content, but it rewrites the stored HTML and bumps `updatedAt`, which is the
  field `update_page` reads to detect somebody else's edit.

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
