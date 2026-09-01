# Configuration

See the [environment variable reference](/reference/environment) for the full table.

## Getting a token

Administration → API → **API Access**. Switch the API on if it is off, then
**New API Key**: give it a name, an expiry, and either full access or a group.

```sh
WIKIJS_URL=https://wiki.example.com
WIKIJS_TOKEN=eyJhbGciOi…
```

`WIKIJS_API_KEY` is accepted as an alias, so moving here from another Wiki.js MCP
server is a change of command, not of environment.

Wiki.js shows the key **once**. There is no way to read it back — `list_api_keys`
returns only a truncated form — so a lost key has to be revoked and replaced.

## Required scopes

Wiki.js scopes are per group and, for pages, per page rule. What this server needs
depends on which tools you actually use:

| Doing this | Needs |
| --- | --- |
| Listing and searching pages | `read:pages` |
| Reading page **content** | `read:source` — separate from `read:pages` |
| History, versions, diffs | `read:history` |
| Creating and editing pages | `write:pages` |
| Moving and deleting pages | `manage:pages`, `delete:pages` |
| Comments | `read:comments`, `write:comments`, `manage:comments` |
| Assets | `read:assets`, `write:assets`, `manage:assets` |
| Users, groups, system, API keys | `manage:system` |

::: warning `read:source` is the one that surprises people
It is separate from `read:pages`, and Wiki.js fails the **whole** query when a
field-level scope is missing. This server therefore fetches metadata and content in
two queries: without `read:source` you still get titles, paths and tags, plus a note
saying why the text is missing, instead of "page not found".
:::

A key confined to a group also inherits that group's **page rules**, which is the
only mechanism that hides pages from this server and the web UI alike.
`WIKIJS_ALLOWED_PATHS` narrows writes on top of that, and `get_group` shows what a
group is actually allowed.

## The locale

Wiki.js treats the locale as part of a page's identity: `docs/setup` under `en` and
under `de` are two different pages, not two renderings of one. Every tool here falls
back to `WIKIJS_LOCALE` (default `en`), so on a wiki set up in another language:

```sh
WIKIJS_LOCALE=de
```

Without it, every lookup by path answers "not found" on a wiki that plainly has the
page. `list_locales` shows what is installed.

## Confining writes to part of the wiki

`WIKIJS_ALLOWED_PATHS` limits the writing page and asset tools to a set of path
prefixes:

```sh
WIKIJS_ALLOWED_PATHS=docs,team/notes
```

Matching is by path segment, so `docs` covers `docs/setup` and **not**
`docs-archive/old` — two page trees that merely begin with the same letters.
`move_page` checks source and destination, so a page cannot be moved out of the
allowed area or into a protected one.

Reads are deliberately **not** restricted. A scope on reads turns a wiki into a
confusing half-wiki where the tree has holes, and the API key's own page rules are
the right place to hide pages outright — they hide them from the browser too.

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

## TLS

Use `https://`. Over plain http the API key travels unencrypted and the server
prints a warning unless the host is loopback.

For an instance with a self-signed certificate, prefer adding your internal CA to
the trust store. If that is genuinely not possible:

```sh
WIKIJS_INSECURE_TLS=true
```

This is scoped to this server's own connections through a dedicated dispatcher — it
does not set `NODE_TLS_REJECT_UNAUTHORIZED` and does not affect anything else in the
process.

## Read-only

```sh
WIKIJS_READ_ONLY=true
```

The write tools are not registered at all: 27 tools instead of 62, and there is no
call to refuse because there is no tool to call.

<!-- The heading below is fixed: every repository uses "Choosing the tools that
     load", so /guide/configuration#choosing-the-tools-that-load is the same anchor
     everywhere and the README, the FAQ and the tool reference can all link to it.
     Put it directly after the read-only section — they are the same knob family,
     and that adjacency does half the explaining. -->

## Turning the approval dialog off

The destructive and administrative tools ask a person through MCP elicitation
before they act. `ELICITATION=false` takes them to the two-call token instead. It
does not remove the guard; there is no setting in which a guarded call goes
unannounced.

The variable deliberately carries no `WIKIJS_` prefix, which means it reaches every
MCP server in the same environment, and — unlike the booleans here — a value it does
not recognise **stops the server** rather than failing off. See
[Asking a person](/guide/approval).

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you.
`WIKIJS_ALLOW_TOOLS` and `WIKIJS_DENY_TOOLS` let you draw your own:

```sh
WIKIJS_ALLOW_TOOLS=essential
WIKIJS_ALLOW_TOOLS=get_page,search_pages,list_*
WIKIJS_DENY_TOOLS=delete_*,purge_page_history,set_api_state
```

Why bother, when all of them work: a model chooses the right tool far more reliably
from a handful than from a long list, and every tool it can see costs context on
every single request. If this is the only MCP server in a session, the full set is
fine. If it is one of six, it is not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or a
prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_thing` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset: `search_pages`, `grep_pages`, `get_page`, `list_pages`, `get_page_tree`, `create_page` and `update_page`. It is marked per tool in the
[tool reference](/reference/tools), generated from the same constant the filter
reads, so the two cannot drift. It composes — naming a tool alongside it puts that
one back, and `WIKIJS_DENY_TOOLS` takes one away.

**Both together.** `WIKIJS_ALLOW_TOOLS` decides what is in;
`WIKIJS_DENY_TOOLS` is then subtracted from the result. With only a deny
list, everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable. The
same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming one
explicitly in `WIKIJS_ALLOW_TOOLS` is an error that says so — rather than
calling a tool unknown when it plainly exists. A _pattern_ that covers write tools is
fine and simply contributes nothing, which is what makes `get_*,create_*` a usable
template for both kinds of deployment; and `WIKIJS_ALLOW_TOOLS=essential`
narrows to the read half of the preset.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and unknown to
`tools/call` alike — exactly what `WIKIJS_READ_ONLY` does to a write tool.
There is no "hidden but callable" state to reason about.
:::
