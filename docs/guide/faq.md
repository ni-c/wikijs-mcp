# FAQ & troubleshooting

<!-- Keep this entry. "A tool is missing" is the one question the tool filter
     creates, and the answer people reach for first — a bug — is the wrong one. -->

## One tool I expected is missing

Something narrowed the list. In order of likelihood:

- `WIKIJS_READ_ONLY` is set, and it is a write tool.
- `WIKIJS_ALLOW_TOOLS` is set and does not name it — it is an allow list, so
  anything not named is out.
- `WIKIJS_DENY_TOOLS` names it, possibly through a prefix such as `delete_*`.

A filtered tool is not registered at all, so it is missing from `tools/list` and
answers `tools/call` with "tool not found" — the same as a write tool under
read-only. There is no state where it is hidden but still callable.

What it is _not_ is a typo in one of those variables: an entry that matches no tool
stops the server at startup and says which entry it was. See
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## Search finds nothing, but the words are definitely on the page

Wiki.js' default search engine is **"Database - Basic"**, and it indexes page titles
and descriptions only. Text written *inside* a page is not searchable at all — the
engine simply has no index of it, so `search_pages` correctly returns zero hits.

`search_pages` reports which engine is active, so you can tell at a glance. Two ways
forward:

- **`grep_pages`** fetches pages and matches their text locally. Slower — one
  request per page — but it finds things. Narrow it with `path_prefix`, `tags` or
  `locale`.
- **Switch the engine.** Administration → Search Engine → Database - PostgreSQL (or
  Elasticsearch), then run `rebuild_search_index` **once**. A new engine starts
  empty, and until it is rebuilt search silently returns nothing at all, which looks
  exactly like a broken installation.

## `update_page` refuses to write and talks about a conflict

Somebody saved the page between your `get_page` and your `update_page` — from the
web editor, or another client. Writing now would discard their edit without either
of you noticing, so the server stops.

- `get_page_conflict` shows the newer version, with who saved it and when.
- Re-read the page with `get_page` and redo your change on top of it.
- `force: true` overwrites their edit deliberately.

The comparison is against the moment **you** read the page, not the moment the
handler read it — the latter is a millisecond old and can never fail, which would be
protection in appearance only.

## Everything answers "not found", but the pages are there

The locale. Wiki.js treats it as part of a page's identity, and this server defaults
to `en`. On a wiki set up in German every path lives under `de`, so `docs/setup`
genuinely does not exist. Set `WIKIJS_LOCALE=de`, or pass `locale` per call;
`list_locales` shows what is installed.

## A page's metadata comes back but its text does not

The API key lacks `read:source`, which Wiki.js keeps separate from `read:pages`. The
result says so rather than pretending the page is empty. Add the scope to the key's
group, or use `mode: "rendered"`, which sometimes remains available.

## Everything fails with an HTML error, or "answered /graphql with text/html"

`WIKIJS_URL` is not pointing at a Wiki.js server, or a proxy answered instead. Wiki.js
serves its web UI from the same origin as `/graphql` and falls back to it for
anything it does not route, so a wrong URL replies **200 with a web page** rather
than a 404. `get_site_info` is the quickest check.

## Creating comments fails with "Too many requests"

Wiki.js rate-limits comment creation to roughly one per second, although its
documentation says the API is not throttled at all. Wait a moment and call again.
