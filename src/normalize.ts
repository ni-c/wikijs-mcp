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

/** Stands in for a username and password lifted out of a URL. */
const REDACTED_USERINFO = 'redacted';

/** Ends the userinfo of a URL: whitespace, the path, a query, a fragment, or the `@` itself. */
function endsUserinfo(char: string | undefined): boolean {
  return (
    char === undefined ||
    char === '/' ||
    char === '?' ||
    char === '#' ||
    char === '@' ||
    /\s/.test(char)
  );
}

/**
 * Removes credentials embedded in a URL's userinfo, wherever the URL sits.
 *
 * Wiki.js' git storage module is configured with a `repoUrl`, and the ordinary
 * way to give it a personal access token is
 * `https://user:token@github.com/org/wiki.git`. The field name says nothing
 * about a secret, so only looking at the value catches it — and the value is
 * not always the whole string: a storage target's `status.message` is git's
 * own stderr, which names the remote in the middle of a sentence. This used to
 * scrub only a string that *was* a URL, and let that sentence through.
 *
 * Hand-walked rather than a regex: a pattern that opens with a scheme class
 * (`[a-z][a-z0-9+.-]*://`) is retried from every letter of a run that never
 * reaches `://`, which is quadratic in a page body. `indexOf` finds each `://`
 * once; the userinfo walk stops at the first character that cannot be in one,
 * and no character is walked twice.
 */
function scrubUrlCredentials(value: string): string {
  let out = '';
  let copied = 0;
  let from = 0;
  for (;;) {
    const separator = value.indexOf('://', from);
    if (separator === -1) break;
    from = separator + 3;
    let at = from;
    while (!endsUserinfo(value[at])) at++;
    if (value[at] !== '@') continue;
    out += `${value.slice(copied, from)}${REDACTED_USERINFO}`;
    copied = at;
    from = at + 1;
  }
  return copied === 0 ? value : out + value.slice(copied);
}

function isSensitiveConfigKey(name: string): boolean {
  const lower = name.toLowerCase();
  // "key" alone would swallow harmless identifiers like `providerKey`, so the
  // bare word only counts when it is not obviously a name or an identifier.
  return SENSITIVE_CONFIG_HINTS.some((hint) => lower.includes(hint));
}

/** The character at a code point, so the class below is spelled in numbers. */
const at = (codePoint: number): string => String.fromCodePoint(codePoint);

/**
 * The C0 and C1 controls and DEL, minus tab, line feed and carriage return.
 *
 * Built from code points rather than written as escapes: an editing tool that
 * rewrites `\uXXXX` in source into the character itself would otherwise leave
 * the raw bytes in this file, where a later edit cannot match them and a
 * reviewer cannot see them.
 */
const CONTROL_CHARACTERS = new RegExp(
  `[${at(0)}-${at(8)}${at(0x0b)}${at(0x0c)}${at(0x0e)}-${at(0x1f)}${at(0x7f)}-${at(0x9f)}]`,
  'g'
);

/**
 * Text as it may reach the model.
 *
 * Wiki.js hands this server whatever somebody typed or pasted into an editor,
 * a comment box or a profile field, and a terminal-shaped client renders an
 * escape sequence rather than showing it. The controls go; the format
 * characters (`Cf` — bidi marks, zero-width joiners) stay, because in a wiki
 * they are content. And `toWellFormed()` because a lone surrogate — from a
 * `\ud800` escape in the backend's JSON, or a window cut through the middle of
 * a pair — is legal on the wire and a `UnicodeEncodeError` in a Python client.
 *
 * Applied to every string in every result, page bodies included. An edit
 * whose `old_text` was copied from a page that carried a control character
 * then fails to match, loudly, which is the right failure: the alternative is
 * a body the model cannot see the whole of.
 */
export function cleanText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, '').toWellFormed();
}

/**
 * A configuration value or an argument as a diagnostic may quote it.
 *
 * Control characters stripped and cut to `max` characters, so that a token
 * pasted into the wrong variable is printed as its first forty characters at
 * most — the header of a JWT, never its signature.
 */
export function quoted(value: string, max = 40): string {
  const clean = cleanText(value);
  return clean.length > max ? `${clean.slice(0, max).toWellFormed()}…` : clean;
}

/**
 * Returns a copy of `data` with credential-shaped values replaced and every
 * string cleaned for the model.
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
  if (typeof node === 'string') return cleanText(scrubUrlCredentials(node));
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

  // `Object.fromEntries` rather than `out[key] = …`: a key spelled `__proto__`
  // — an own property after JSON.parse, legal JSON from any backend — would
  // set the copy's prototype and drop the field. Wiki.js chooses no key today;
  // the copy is built so that it could.
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      isSensitiveName(key) ? REDACTED : visit(value),
    ])
  );
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

/**
 * The `id` of a record, as an id this server can send back.
 *
 * Every page tool reads the id off the metadata it just fetched and puts it
 * into the next document as `$id: Int!`. A cast (`page.id as number`) is not a
 * check: an id that is missing, a string or `1e300` went into the read log and
 * the next query as it was, and the failure surfaced two calls later as a
 * GraphQL validation error that named nothing.
 */
export function idOf(record: Record<string, unknown>, what: string): number {
  const id = record.id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 1) return id;
  throw new Error(`Wiki.js returned ${what} without a usable id.`);
}

const MAX_ERROR_BODY_LENGTH = 2000;

/**
 * Limits what an upstream error body can inject into the model context.
 *
 * Wiki.js' GraphQL errors are JSON, but a proxy or WAF in front of it answers
 * with an HTML page, which is pure noise here. What survives is cleaned like
 * every other string the instance wrote — an error message is the one place
 * a control character reaches the model without passing the result walk.
 *
 * Lives here rather than beside the error results it is used from: `api.ts`
 * needs it in a constructor, and `result.ts` imports `api.ts`, so keeping it
 * there would have made the two files import each other.
 */
export function sanitizeErrorBody(body: string): string {
  const trimmed = cleanText(body).trim();
  // Anything markup-shaped: a reverse proxy's error page or a WAF block page.
  // The check is deliberately loose — an XML declaration, a leading comment or
  // a doctype followed by a newline are all the same thing here.
  if (/^(<!doctype|<html[\s>]|<\?xml|<!--)/i.test(trimmed)) {
    return '(HTML error page omitted)';
  }
  if (trimmed.length > MAX_ERROR_BODY_LENGTH) {
    return `${trimmed.slice(0, MAX_ERROR_BODY_LENGTH).toWellFormed()}… (truncated)`;
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
