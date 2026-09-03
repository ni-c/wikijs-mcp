# Security

This page is the prose version of [SECURITY.md](https://github.com/ni-c/wikijs-mcp/blob/main/SECURITY.md).

## Trust model

`WIKIJS_TOKEN` is a Wiki.js API key, and Wiki.js API keys are administrative by
construction: the key dialog offers "full access" or a group, and most people take
full access. A full-access key can read every page including private ones, rewrite
or delete any of them, create and delete accounts, change group permissions and
switch the API off. Compromising it is compromising the wiki.

Three things narrow that, and they compose:

- **`WIKIJS_READ_ONLY=true`** registers only the read tools. There is no call to
  refuse, because there is no tool to call.
- **`WIKIJS_ALLOWED_PATHS`** confines the writing tools to path prefixes, matched
  by path segment.
- **The key's own group and page rules.** The only one of the three that also
  applies to everything else using the key, and the right place to hide pages.

There is deliberately **no tool that creates an API key**, although the Wiki.js API
offers one. A model able to mint a full-access key could grant itself durable
administrative access to the wiki — access that outlives this session, this server
and any later tightening of its configuration. `list_api_keys` and `revoke_api_key`
are here so keys can be audited and taken away.

The MCP client process, and therefore the model driving it, sees every tool result.
Do not point this server at a wiki whose contents you would not put in a model's
context.

## The confirmation, honestly

Every destructive or administrative operation **asks a person**. Where the MCP
client supports elicitation, that is a dialog shown to whoever is sitting there —
the model cannot answer it on their behalf, and nothing happens until an answer
comes back.

This is not a `confirm: true` parameter, and the difference matters: a boolean can
be set by the model on its first call, or be talked into it by text hidden in a
wiki page it just read.

Where the client cannot show a dialog, the first call performs nothing and returns
a random 32-character token; only a second call carrying it acts. The token expires
after five minutes, is single-use, and is compared in constant time. Be clear about
what it proves, because this server is: **the call was made twice with the same
arguments, and nothing more.** A model can read it out of the first result and quote
it back in the same turn. The fallback text says so rather than implying somebody
approved, and names whether it was the client that could not be asked or the
operator who switched the dialog off with `ELICITATION=false`.

Either way the approval is bound to the **exact target**, not just to the tool name.
The binding covers everything that decides what is touched, with each value labelled
by its role — so one issued for `migrate_pages_locale` from `de` to `en` will not run
`en` to `de`, and one for "delete user 1, reassign to 2" will not run "delete user 2,
reassign to 1". An approval given for different arguments is refused with a message
that distinguishes it from no approval at all.

::: info Three maintenance tools used to be gated, and are not any more
`flush_page_cache`, `rebuild_page_tree` and `rebuild_search_index` are instance-wide
and slow, and that was the argument. **Nothing is lost by any of them** — the cost is
time, not content — and a dialog in front of an operation that loses nothing is how
people learn to tick without reading, which spends exactly the attention
`purge_page_history` needs. Their `confirm_token` parameter is gone from the schema
too, so a caller that still sends one is told rather than quietly ignored. They are
nonetheless refused while `WIKIJS_ALLOWED_PATHS` is set: whether an operation needs a
person's attention and whether it stays inside the prefix an operator named are two
different questions.
:::

See [Asking a person](/guide/approval).

## Untrusted content

A wiki is precisely a place where text is stored so that it can be read later —
which makes every page a channel for whoever can edit it. Page bodies, titles,
descriptions, comments and version history all come back wrapped in an explicit
marker saying they are data and not instructions.

Confirmation prompts never quote any of it. Only ids, paths and server-side values
appear in them, and a path is checked to be a bare identifier — no whitespace,
quotes or control characters — before it is interpolated into a string the model
will read.

Secrets in API responses are redacted by field name anywhere in the tree, which
covers storage-target and search-engine configurations where credentials arrive as
`{key, value}` pairs. Error bodies are truncated, HTML error pages are dropped, and
every response is bounded to 100 kB by dropping whole entries rather than slicing
the JSON.

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/ni-c/wikijs-mcp/security/advisories/new).
