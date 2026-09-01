# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/wikijs-mcp.git && cd wikijs-mcp
npm install
npm test          # unit tests against a stubbed GraphQL layer
npm run build
```

## Running the integration suite

The unit tests stub `fetch`, so they check that this server does what its author
believed Wiki.js does. The integration suite checks what Wiki.js does. It spawns
the built server over stdio against a throwaway Wiki.js in Docker and calls
**every tool in the catalogue** — the deletes included — so the backend has to be
one nobody wants: `test/integration/compose.yml` binds to `127.0.0.1` only, and
the harness refuses any backend URL that is not on this machine.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

The `down -v` is not tidiness. The suite creates fixtures at fixed paths and
needs an instance that has never been set up; against a second run it stops with
a message saying so, because Wiki.js answers `/finalize` with a 404 once it is
configured and that reads like a wrong URL rather than a wrong state.

CI runs it on every pull request against the pinned image, and weekly against
`requarks/wiki:2` — the first catches regressions here, the second catches
Wiki.js moving. It is deliberately not a gate on `publish`; see the comment in
`ci.yml`.

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs the unit tests on Node 22 and 24, the integration suite against a
  real Wiki.js, oxlint, prettier, `npm audit`, CodeQL and a Trivy scan of the
  container image.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature. In particular the GraphQL layer is hand-written on top of `fetch` — a
  client library would bring its own network stack, and the hardening in
  `src/api.ts` (scoped TLS dispatcher, redirect refusal, byte ceiling) would have
  to be pushed underneath it anyway.
- **Anything you learn about the Wiki.js API belongs in a comment.** Several of its
  behaviours are surprising enough to have cost a debugging session each — a null
  `title` is rejected while a null `isPublished` is not, `users.search` cannot
  return `isSystem`, comment creation is rate-limited although the documentation
  says nothing is. Those notes are why the next change does not rediscover them.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/wikijs-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/wikijs-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/wikijs-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
