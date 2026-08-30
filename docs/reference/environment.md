# Environment variables

<!-- One table, this shape. Three of the eleven repositories grew a
     heading-per-variable style instead; both read fine, but a new server starts
     here so that the family stops adding variants. -->

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WIKIJS_URL` | yes | — | Base URL of the Wiki.js instance, e.g. `https://wiki.example.com`. A trailing `/graphql` is trimmed |
| `WIKIJS_TOKEN` | yes | — | API key from Administration → API Access. `WIKIJS_API_KEY` is accepted as an alias |
| `WIKIJS_LOCALE` | no | `en` | Locale assumed by page tools that are not given one |
| `WIKIJS_READ_ONLY` | no | `false` | `true` registers only the read tools |
| `WIKIJS_ALLOWED_PATHS` | no | — | Page path prefixes the write tools are confined to, e.g. `docs,team/notes` |
| `WIKIJS_ALLOW_TOOLS` | no | — | Tool names, `list_*` prefixes or `essential`; only these register |
| `WIKIJS_DENY_TOOLS` | no | — | Same syntax; subtracted from whatever the allow list left |
| `WIKIJS_INSECURE_TLS` | no | `false` | `true` accepts self-signed certificates |

## `WIKIJS_LOCALE`

The locale is part of a page's identity in Wiki.js, not a display preference:
`docs/setup` under `en` and under `de` are two different pages. Every tool that
takes a `locale` falls back to this value, so a wiki set up in another language
needs it — otherwise every lookup by path answers "not found" on a wiki that
plainly has the page. `list_locales` reports what is installed.

## `WIKIJS_ALLOWED_PATHS`

Comma-separated page path prefixes. The **writing** page and asset tools refuse a
target outside them; reads are unaffected.

Matching is by path segment: `docs` covers `docs` itself and anything under
`docs/`, and does **not** cover `docs-archive`. `move_page` checks its source and
its destination, so a page can be moved neither out of the allowed area nor into a
protected one.

An empty or whitespace-only value counts as unset, the same as the tool lists. A
prefix containing `..` or a wildcard aborts startup.

Four things it cannot confine, and refuses instead of pretending:

- `purge_page_history` and `migrate_pages_locale` act on every page there is.
- `update_tag` and `delete_tag` affect every page carrying the tag, wherever it
  lives.
- `update_comment` and `delete_comment` — Wiki.js does not report which page a
  comment belongs to, so there is no way to tell whether it is inside the
  allowed area. `create_comment` is given the page and is checked normally.

Each of those refuses with a message naming the variable. Unset it to run them.

Asset writes are checked against the **asset folder** path, which is a separate
namespace from page paths: with `WIKIJS_ALLOWED_PATHS=docs`, uploads go into the
asset folder `docs` or below, and the root is refused.

This is a second line, not the first one: the API key's own group and page rules in
Wiki.js are what actually hide pages, from this server and the web UI alike.

## Narrowing the tool list

`WIKIJS_ALLOW_TOOLS` and `WIKIJS_DENY_TOOLS` are comma-separated.
Each entry is either an exact tool name or a prefix with a single trailing `*`:

| Value | Registers |
| --- | --- |
| `essential` | the curated preset, marked in the [tool reference](/reference/tools) |
| `get_page,search_pages,list_*` | exactly those |
| `list_*` | every tool whose name starts with `list_` |
| `*` | everything — the same as leaving it unset |

Entries are trimmed and matched case-insensitively; empty entries are ignored, and a
value that is empty or only whitespace counts as unset — `WIKIJS_ALLOW_TOOLS=`
in a compose file does not mean "allow nothing". `essential` is recognised only in the
allow list.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_thing` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under `WIKIJS_READ_ONLY`, an exact write-tool name in the allow list is an
error naming the read-only setting rather than "unknown tool"; a pattern covering
write tools is accepted and merely contributes nothing, with a warning on stderr.
Deny entries are exempt: denying an already-suppressed tool is how a defensive list is
written.
