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
];

function isSensitiveName(name: string): boolean {
  return SENSITIVE_KEYS.has(name.toLowerCase());
}

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
