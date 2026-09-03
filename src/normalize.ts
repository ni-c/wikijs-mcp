/** Replaces a secret, rather than dropping it: an absent field reads as "there is none". */
export const REDACTED = '(redacted by wikijs-mcp)';

/**
 * Field names whose value never belongs in a model's context.
 *
 * Matched by name anywhere in the tree rather than at known paths, so a field
 * Wiki.js starts returning after an upgrade is redacted the day it appears
 * instead of the day somebody notices.
 *
 * `dbHost`, `configFile` and `workingDirectory` are not credentials but they
 * describe the host filesystem and internal network, which is the half of
 * `system.info` that has no business leaving the instance.
 */
const SENSITIVE_KEYS = new Set(
  [
    'pass',
    'password',
    'passwordRaw',
    'newPassword',
    'currentPassword',
    'secret',
    'sessionSecret',
    'privateKey',
    'dkimPrivateKey',
    'apiKey',
    'accessKey',
    'secretKey',
    'accessKeyId',
    'secretAccessKey',
    'token',
    'jwt',
    'continuationToken',
    'tfaSecret',
    'dbPass',
    'dbHost',
    'configFile',
    'workingDirectory',
    'sslSubscriberEmail',
    'telemetryClientId',
  ].map((key) => key.toLowerCase())
);

/**
 * Substrings that make a *configuration entry* sensitive.
 *
 * Storage targets and search engines return their settings as a
 * `[{ key, value }]` list, so the interesting name is a value inside the object
 * rather than the property holding it — an S3 target's secret access key is
 * `{ key: "secretAccessKey", value: "…" }`, and the plain key scan above would
 * only ever see the property called `value`.
 */
const SENSITIVE_CONFIG_HINTS = [
  'pass',
  'secret',
  'token',
  'key',
  'credential',
  'auth',
  // Storage targets expose where they write as well as what they write with,
  // and the host filesystem layout is the same class of thing the top-level
  // `configFile` and `workingDirectory` entries above are blocked for.
  'path',
  'endpoint',
  'host',
];

/**
 * Names that contain a sensitive-looking word but are not sensitive.
 *
 * Needed because the check below is by substring rather than by equality — the
 * docstring above promises a field Wiki.js starts returning after an upgrade is
 * redacted the day it appears, and exact matching only ever catches the names
 * somebody already thought of. `clientSecret`, `refreshToken` and `smtpPassword`
 * all went straight through before this changed.
 */
const NOT_SENSITIVE = new Set(
  ['providerkey', 'keyshort', 'dkimkeyselector', 'key', 'keys', 'apikeys'].map(
    (name) => name.toLowerCase()
  )
);

/** Words that make a field name credential-shaped. */
const SENSITIVE_NAME_HINTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
  'privatekey',
  'accesskey',
  'secretkey',
  'apikey',
  'jwt',
  'salt',
  'tfasecret',
];

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  if (NOT_SENSITIVE.has(lower)) return false;
  if (SENSITIVE_KEYS.has(lower)) return true;
  return SENSITIVE_NAME_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Removes credentials embedded in a URL's userinfo.
 *
 * Wiki.js' git storage module is configured with a `repoUrl`, and the ordinary
 * way to give it a personal access token is
 * `https://user:token@github.com/org/wiki.git`. The field name says nothing
 * about a secret, so only looking at the value catches it.
 */
function scrubUrlCredentials(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (!parsed.username && !parsed.password) return value;
  parsed.username = REDACTED_USERINFO;
  parsed.password = '';
  return parsed.toString();
}

/** Stands in for a username and password lifted out of a URL. */
const REDACTED_USERINFO = 'redacted';

function isSensitiveConfigKey(name: string): boolean {
  const lower = name.toLowerCase();
  // "key" alone would swallow harmless identifiers like `providerKey`, so the
  // bare word only counts when it is not obviously a name or an identifier.
  return SENSITIVE_CONFIG_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Returns a copy of `data` with credential-shaped values replaced.
 *
 * Applied by default to everything that goes back to the model. The alternative
 * — remembering to call it at each of sixty tools — is the version that misses
 * one.
 */
export function redactSensitive<T>(data: T): T {
  return visit(data) as T;
}

function visit(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(visit);
  if (typeof node === 'string') return scrubUrlCredentials(node);
  if (node === null || typeof node !== 'object') return node;

  const record = node as Record<string, unknown>;
  // A Wiki.js KeyValuePair: `{ key, value }`, possibly with `hint`.
  if (
    typeof record.key === 'string' &&
    'value' in record &&
    isSensitiveConfigKey(record.key)
  ) {
    return { ...record, value: REDACTED };
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = isSensitiveName(key) ? REDACTED : visit(value);
  }
  return out;
}

/**
 * Asserts that an upstream payload is the array it was supposed to be.
 *
 * GraphQL is typed, so this should never fire — but `data.pages.list` is `null`
 * rather than `[]` when a field-level `@auth` directive refuses it while the
 * rest of the query succeeds, and handing that to `.map` throws a TypeError
 * that says nothing about permissions.
 */
export function listOf(value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) {
    throw new Error(
      `Wiki.js returned no ${what}. This is usually a permission scope the API ` +
        'key lacks — check the key under Administration → API Access.'
    );
  }
  throw new Error(`Wiki.js returned ${what} in an unexpected shape.`);
}

/** The object form of {@link listOf}. */
export function objectOf(
  value: unknown,
  what: string
): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (value === null || value === undefined) {
    throw new Error(
      `Wiki.js returned no ${what} — it does not exist, or the API key may not see it.`
    );
  }
  throw new Error(`Wiki.js returned ${what} in an unexpected shape.`);
}

const MAX_ERROR_BODY_LENGTH = 2000;

/**
 * Limits what an upstream error body can inject into the model context.
 *
 * Wiki.js' GraphQL errors are JSON, but a proxy or WAF in front of it answers
 * with an HTML page, which is pure noise here.
 *
 * Lives here rather than beside the error results it is used from: `api.ts`
 * needs it in a constructor, and `result.ts` imports `api.ts`, so keeping it
 * there would have made the two files import each other.
 */
export function sanitizeErrorBody(body: string): string {
  const trimmed = body.trim();
  // Anything markup-shaped: a reverse proxy's error page or a WAF block page.
  // The check is deliberately loose — an XML declaration, a leading comment or
  // a doctype followed by a newline are all the same thing here.
  if (/^(<!doctype|<html[\s>]|<\?xml|<!--)/i.test(trimmed)) {
    return '(HTML error page omitted)';
  }
  if (trimmed.length > MAX_ERROR_BODY_LENGTH) {
    return `${trimmed.slice(0, MAX_ERROR_BODY_LENGTH)}… (truncated)`;
  }
  return trimmed;
}

/** Keeps only the named properties, dropping undefined ones. */
export function pick<T extends Record<string, unknown>>(
  source: T,
  keys: readonly (keyof T)[]
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
