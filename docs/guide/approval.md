# Asking a person

Twenty-five of the 62 tools remove content, move it, or change who may reach the
wiki. All twenty-five **ask a person first**.

Not a `confirm: true` argument the model can set. Not a token the model reads out
of its own previous result. A dialog, raised through [MCP
elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation),
that goes to the client and is shown to whoever is sitting there.

The specification says a client _should_ keep a human in the loop:

> there **SHOULD** always be a human in the loop with the ability to deny tool
> invocations

This server does not rely on that. It raises the question itself, and until an
answer comes back, nothing happens.

## What asks, and when

| Group | Tools |
| --- | --- |
| Pages | `move_page` · `delete_page` · `convert_page_editor` · `restore_page_version` · `purge_page_history` · `migrate_pages_locale` |
| Tags | `update_tag` · `delete_tag` |
| Assets | `rename_asset` · `delete_asset` |
| Comments | `update_comment` · `delete_comment` |
| Users | `create_user` · `update_user` · `delete_user` · `set_user_active` · `verify_user` · `set_user_tfa` · `reset_user_password` |
| Groups | `update_group` · `delete_group` · `assign_user_to_group` · `unassign_user_from_group` |
| API keys | `revoke_api_key` · `set_api_state` |
| everything else | never asks |

`update_page` is deliberately **not** on that list, and it is the clearest example
of why a per-tool judgement beats a rule about verbs: Wiki.js keeps page history, so
an edit can be read back and restored. `update_comment` *is* on it, because comments
have no history. Same verb, different backend, different answer.

Three maintenance tools came **off** the list: `flush_page_cache`,
`rebuild_page_tree` and `rebuild_search_index`. They are instance-wide and slow, and
that was the argument for gating them — but nothing is lost by any of them. The cost
is time, not content, and a dialog in front of an operation that loses nothing is how
people learn to tick without reading, which spends exactly the attention
`purge_page_history` needs. Their `confirm_token` parameter went with the guard, so a
caller that still sends one is told rather than quietly ignored.

## What the dialog contains

Ids, paths and server-side values. Never a page title, description, comment or body.

A wiki is precisely a place where text is stored so that it can be read later, which
makes every page a channel for whoever can edit it — and the prompt is read by a
model at the exact moment it is deciding. A path is checked to be a bare identifier,
with no whitespace, quotes or control characters, before it is interpolated at all.

```
This will migrate every page from locale "de" to locale "en".

Pages that already exist in the target locale are skipped, and the operation
cannot be reversed by running it the other way round.
```

The approval is bound to its target, so one obtained for a call cannot be
replayed against another. For a *set* of targets the binding is a fingerprint of
the exact list: an approval for `["a"]` does not execute `["a", "b"]`.

## Clients that cannot show a dialog

Not every MCP client implements elicitation, and a stateless gateway may not be
able to speak for the one it is currently serving. Rather than refuse to work —
which pushes people towards switching the guard off entirely — the tool falls
back to a **two-call token**: the first call returns a random string, the second
has to quote it back.

Be clear about what that proves, because this server is:

> the token proves the call was made twice with the same arguments, and nothing
> more.

A model can read the token out of the first result and call again in the same
turn without anybody seeing it. It catches a widened target set; it does not
catch a model that was talked into the whole thing. The fallback text says so
rather than implying somebody approved.

## Switching the dialog off

```sh
ELICITATION=false
```

Default is `true`. `false` does **not** remove the guard — it takes the fallback
path above, which means the token. There is no setting in which a guarded call
goes unannounced.

Use it where a dialog is the wrong shape rather than an unwanted one: a scheduled
job, a test harness, a client whose dialog interrupts something else.

::: warning It is deliberately not prefixed
`ELICITATION` has no `WIKIJS_` in front of it, so one
`export ELICITATION=false` — or one `-e ELICITATION=false` in a compose file —
reaches **every** MCP server in that environment, not just this one. That is the
point of it and also its risk.

Two things make it visible rather than silent:

- a server started with it off prints one line at startup, in the log of every
  server it actually reached:

  ```
  wikijs-mcp: ELICITATION=false — guarded tools fall back to the two-call token
  ```

- the fallback text names the server that did not ask, instead of blaming a
  client that was working fine.
  :::

Anything other than `true` or `false` — `1`, `off`, `yes` — **stops the server**
with exit code 1 and a message naming both valid values. This is the only
variable in this family that defaults to _on_: a typo that fell back to the
default would leave the dialog running while the operator believed it was off,
and there would be nothing to tell them.

## Annotations are the other half, and they are only a hint

Every tool of this server declares all four MCP tool annotations —
`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — so a
client can tell before it calls what a call would do. See
[Tools](/reference/tools).

They are advice, and the specification says so:

> clients **MUST** consider tool annotations to be untrusted unless they come
> from trusted servers

An annotation is something a client may ignore. The dialog is not: it is enforced
here, on the server side, and no answer means no change. The two are different
claims — the annotation says what a call _does_, the dialog decides whether it
_happens_ — which is why a tool can be marked destructive without being guarded.
The binding covers everything that decides *what* is touched, each value labelled by
its role — so an approval for “delete user 1, reassign to 2” will not run “delete
user 2, reassign to 1”.

## Behind a gateway

Both protocol revisions are handled from one code path. On `2025-11-25` the
question is pushed to the client; on `2026-07-28` there is no server→client
channel at all, so the call returns `input_required`, ends, and the client
retries carrying the answer.

That answer arrives as ordinary request content, which the SDK does not
validate — so the state that ties an answer to its question is sealed (HMAC). A
reply whose seal does not open, or opens onto a different target, counts as **no
answer** and produces a fresh question rather than an error. The likeliest cause
is not an attack: it is a gateway that put the server to sleep while the person
was reading.

If you run this behind [mcp-hub](https://github.com/ni-c/mcp-hub), the hub passes
elicitation through in both directions; see its
[elicitation guide](https://ni-c.github.io/mcp-hub/guide/elicitation).
