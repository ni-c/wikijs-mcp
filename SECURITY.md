# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/wikijs-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

`WIKIJS_TOKEN` is a Wiki.js API key, and Wiki.js API keys are administrative by
construction: the key dialog offers "full access" or a group, and most people take
full access. A full-access key can read every page including private ones, rewrite
or delete any of them, create and delete user accounts, change group permissions,
and disable the API. Compromising it is compromising the wiki.

Three things narrow that, and they compose:

- **`WIKIJS_READ_ONLY=true`** registers only the read tools. The write tools are
  never added to the server, so there is no call to refuse.
- **`WIKIJS_ALLOWED_PATHS`** confines the writing page and asset tools to a set of
  path prefixes, matched by path segment — `docs` covers `docs/setup` and not
  `docs-archive`. Asset writes are checked against the asset folder tree, a
  separate namespace from page paths. Operations that cannot be expressed as a
  prefix — instance-wide maintenance, the tag tools, and comment edits, which
  Wiki.js gives no page for — refuse while the variable is set rather than
  quietly becoming exceptions. "Instance-wide maintenance" means all six:
  `purge_page_history` and `migrate_pages_locale`, and also `flush_page_cache`,
  `rebuild_page_tree` and `rebuild_search_index`, which lose nothing but still act
  on every page there is. `render_page` writes one page and is checked against the
  prefix like every other page write. Reads are deliberately unrestricted.
- **The API key's own group and page rules** in Wiki.js. This is the only one of
  the three that also applies to anything else using the key, and it is the right
  place to hide pages outright.

There is deliberately **no tool that creates an API key**, although the Wiki.js API
offers one. A model able to mint a full-access key could grant itself durable
administrative access to the wiki — access that survives this session, this server
and any later tightening of its configuration. `list_api_keys` and `revoke_api_key`
are provided so keys can be audited and taken away.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Destructive and administrative operations **ask a person** through MCP elicitation: a
dialog raised by the server and shown by the client, which the model cannot answer on
its behalf, and which nothing proceeds without. Where the client cannot show one they
fall back to a server-generated token bound to the exact target, which proves the call
was made twice with the same arguments and nothing more; the fallback text says so.
`ELICITATION=false` moves a capable client onto it deliberately — it does not remove
the guard, and the server prints one line at startup saying it is off.

## What a confirmation actually promises

A confirmation is bound to the arguments it was shown for, and to nothing else. The
resource key is built from every argument that decides what the call does — not the
object's id alone, and not a summary such as "4 page rules": `update_group` binds the
name, the permissions, the rule set _and_ the login redirect, because the mutation
replaces all four. A token replayed with any one of them different is refused with
the reason rather than answered with a fresh prompt. `test/confirmation-binding.test.ts`
asserts that for every argument of every gated tool, and fails when a new argument
is added without being accounted for.

What a confirmation promises beyond binding depends on how the answer travels, and
this server serves both protocol revisions through `serveStdio` — the opening
exchange picks `2025-11-25` or `2026-07-28` per connection.

- On `2025-11-25` the dialog is resolved inside the same `tools/call`: there is no
  sealed state on the wire, and nothing to replay.
- On `2026-07-28` the dialog is a return value. `mcp-approval` seals the
  `requestState` that travels through the client and comes back with the answer;
  the seal proves the answer belongs to the question. Since `mcp-approval` 0.8.1 the
  state also carries a nonce that is spent on the first answer, accepted _or_
  declined, so the same state presented again within its lifetime is refused.
  The record of spent states is per process: a restart forgets it, and a state
  sealed before the restart is accepted once more within its fifteen-minute
  lifetime. That is the residual, stated rather than hidden.
- The two-call token is single-use and expires, so it cannot be replayed either.

An earlier revision of this file claimed the sealed state never left the process
because the hand-wired stdio transport pinned `2025-11-25`. That had stopped being
true with the move to `serveStdio`; `test/hardening.test.ts` checks that this file
names the transport the code uses.

Data returned from the upstream API is untrusted input: it is marked as such, and
confirmation prompts never quote it. That includes the text of a refusal Wiki.js
writes itself — its `responseResult.message` is as far upstream as a database driver,
so it is capped and set off under a line saying who wrote it, rather than folded into
this server's own sentence.
