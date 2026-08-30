# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/wikijs-mcp.git && cd wikijs-mcp
npm install
npm test          # unit tests against a stubbed GraphQL layer
npm run build
```

A minimal dev environment:

```sh
# A throwaway Wiki.js to develop against — never point this at a wiki you care
# about, because scripts/sandbox/smoke.mjs exercises the destructive tools too.
docker compose -f scripts/sandbox/docker-compose.yml up -d
python3 scripts/sandbox/bootstrap.py     # finalizes setup, mints an API key

npm run build
node scripts/sandbox/smoke.mjs           # calls every tool once, end to end
node scripts/sandbox/conflict.mjs        # proves the concurrent-edit guard

docker compose -f scripts/sandbox/docker-compose.yml down -v
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs the unit tests on Node 22 and 24, eslint, prettier, `npm audit`, CodeQL and a Trivy scan of the container image.
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
- Run `npm run lint` before pushing — it checks both eslint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/wikijs-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/wikijs-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/wikijs-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
