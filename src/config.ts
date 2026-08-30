/**
 * Locale used when a tool does not name one.
 *
 * Wiki.js requires a locale on nearly every page operation and a fresh install
 * only has `en` installed, so this is right far more often than it is wrong —
 * but a wiki that was set up in German has every page under `de`, and then every
 * single call would answer "page not found" until `WIKIJS_LOCALE` is set.
 */
export const DEFAULT_LOCALE = 'en';

export interface Config {
  /**
   * Base URL of the Wiki.js instance, e.g. `https://wiki.example.com`. The
   * `/graphql` suffix is added by the API client.
   *
   * May be undefined together with the token: the server still starts and lists
   * its tools, every API call then fails with {@link missingConfigMessage}.
   */
  url: string | undefined;
  /** API key from Administration → API Access. */
  token: string | undefined;
  /** Locale assumed by page tools that were not given one. */
  locale: string;
  insecureTls: boolean;
  readOnly: boolean;
  /**
   * Raw value of `WIKIJS_ALLOWED_PATHS` — comma-separated page path prefixes
   * that the write tools are confined to. Kept unparsed for the same reason as
   * the tool lists: this file mirrors the environment, `buildPathScope`
   * interprets it.
   */
  allowedPaths: string | undefined;
  /**
   * Raw value of `WIKIJS_ALLOW_TOOLS` — comma-separated tool names,
   * `list_*` prefixes, or `essential`. Kept unparsed on purpose: this file is a
   * mirror of the environment, and the names can only be checked against the
   * tool catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `WIKIJS_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every API call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: WIKIJS_URL (e.g. https://wiki.example.com), WIKIJS_TOKEN ' +
    '(Administration → API Access → New API Key; WIKIJS_API_KEY is accepted as ' +
    'an alias)\n' +
    `Optional: WIKIJS_LOCALE to change the assumed page locale (default ${DEFAULT_LOCALE}), ` +
    'WIKIJS_READ_ONLY=true to expose only read tools, ' +
    'WIKIJS_ALLOWED_PATHS to confine the write tools to page path prefixes, ' +
    'WIKIJS_INSECURE_TLS=true to accept self-signed certificates, ' +
    'WIKIJS_ALLOW_TOOLS / WIKIJS_DENY_TOOLS to narrow the tool list ' +
    '(comma-separated names, "list_*" prefixes, or "essential")'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [!config.url && 'WIKIJS_URL', !config.token && 'WIKIJS_TOKEN'].filter(
    (v): v is string => Boolean(v)
  );
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the token to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.WIKIJS_URL;
  // Wiki.js calls the credential an "API Key" in its own administration UI, and
  // every other Wiki.js MCP server reads WIKIJS_API_KEY — so moving to this one
  // must not be an environment rewrite. WIKIJS_TOKEN is the documented name
  // because that is what the neighbouring servers use.
  const token = env.WIKIJS_TOKEN ?? env.WIKIJS_API_KEY;
  const locale = env.WIKIJS_LOCALE?.trim() || DEFAULT_LOCALE;
  const insecureTls = env.WIKIJS_INSECURE_TLS === 'true';
  const readOnly = env.WIKIJS_READ_ONLY === 'true';
  const allowedPaths = env.WIKIJS_ALLOWED_PATHS;
  const allowTools = env.WIKIJS_ALLOW_TOOLS;
  const denyTools = env.WIKIJS_DENY_TOOLS;

  // Don't keep the key in the environment for the process lifetime — it is
  // visible to child processes and in /proc/<pid>/environ. Before any early
  // return, so the branch that is taken cannot decide whether it happens.
  delete env.WIKIJS_TOKEN;
  delete env.WIKIJS_API_KEY;

  const missing = [!url && 'WIKIJS_URL', !token && 'WIKIJS_TOKEN'].filter(
    (v): v is string => Boolean(v)
  );

  if (missing.length > 0) {
    console.error(`wikijs-mcp: ${missingConfigMessage(missing)}`);
  }

  const base: Config = {
    url: undefined,
    token,
    locale,
    insecureTls,
    readOnly,
    allowedPaths,
    allowTools,
    denyTools,
  };

  if (!url) return base;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never echo the rejected value: it is the one place a token pasted into
    // the wrong variable would be printed.
    console.error('wikijs-mcp: WIKIJS_URL is not a valid URL');
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `wikijs-mcp: WIKIJS_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'wikijs-mcp: WIKIJS_URL must not contain credentials — use WIKIJS_TOKEN'
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    console.error(
      'wikijs-mcp: WARNING: WIKIJS_URL uses plain http to a non-local host — ' +
        'the API key will be sent unencrypted. Use https:// instead.'
    );
  }

  // From `parsed`, not the raw value: a query or fragment would otherwise
  // survive the slash trim and end up glued in front of /graphql.
  base.url = `${parsed.origin}${parsed.pathname}`
    .replace(/\/+$/, '')
    .replace(/\/graphql$/, '');
  return base;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('127.') ||
    hostname === '::1'
  );
}
