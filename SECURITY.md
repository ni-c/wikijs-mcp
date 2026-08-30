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
  `docs-archive`. Reads are deliberately unrestricted.
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

Destructive operations require a server-generated confirmation token that is bound to
the specific target; a model cannot satisfy that gate on its own. Data returned from
the upstream API is untrusted input: it is marked as such, and confirmation prompts
never quote it.
