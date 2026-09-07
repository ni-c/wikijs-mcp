import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';

import {
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from './config.js';
import { sanitizeErrorBody } from './normalize.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Ceiling on a single upstream response.
 *
 * Wiki.js bounds nothing: `pages.list` has a `limit` but `pages.tree`,
 * `pages.links` and `pages.search` have none, and `Page.content` is whatever
 * somebody pasted into the editor. `await response.text()` would buffer all of
 * it; this bounds the bytes before they are ever a string.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Ceiling on the body of an answer that already failed by its status.
 *
 * Small, and read with a reader that cuts rather than refuses: the status is
 * the answer, the body is at most a hint. A reverse proxy's two-megabyte login
 * page behind a 401 used to be reported as "the response exceeds the 32 MB
 * ceiling" — the size, not the status, and no word about credentials.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Longest header value this server will send. */
const MAX_HEADER_VALUE_LENGTH = 8192;

/** A GraphQL error entry as Wiki.js returns it. */
export interface GraphQLErrorEntry {
  message: string;
  extensions?: { code?: string; exception?: { code?: number } };
}

/** The transport failed: a non-2xx answer from the HTTP layer. */
export class WikiJsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly operation: string
  ) {
    super(`Wiki.js API ${operation} failed with HTTP ${status}`);
    this.name = 'WikiJsApiError';
  }
}

/**
 * The query ran and GraphQL refused it.
 *
 * This is the error path that does not look like one. GraphQL answers **HTTP
 * 200 with an `errors` array**, so a client that only checks `response.ok`
 * treats a permission failure as a successful call returning `data: null` — and
 * every list helper downstream reports an empty wiki rather than an error.
 */
export class WikiJsGraphQLError extends Error {
  /**
   * The entries, each reduced to the shape the type promises.
   *
   * The wire promises nothing: `errors: [null]` or an entry whose `message` is
   * a number is legal JSON from whatever answers at `WIKIJS_URL`, and the
   * previous constructor read `.message` off each entry as it came, so the
   * first malformed one turned a refusal into a TypeError about `null`.
   */
  public readonly errors: GraphQLErrorEntry[];

  constructor(
    errors: unknown[],
    public readonly operation: string
  ) {
    const entries = errors.flatMap((entry): GraphQLErrorEntry[] => {
      if (entry === null || typeof entry !== 'object') return [];
      const { message, extensions } = entry as {
        message?: unknown;
        extensions?: unknown;
      };
      const shaped: GraphQLErrorEntry = {
        message: typeof message === 'string' ? message : '(no message given)',
      };
      if (extensions !== null && typeof extensions === 'object') {
        shaped.extensions = extensions as NonNullable<
          GraphQLErrorEntry['extensions']
        >;
      }
      return [shaped];
    });
    super(
      `Wiki.js rejected ${operation}: ${entries.map((e) => e.message).join('; ')}`
    );
    this.errors = entries;
    this.name = 'WikiJsGraphQLError';
  }

  /** True when the refusal was about permissions rather than the query itself. */
  get isForbidden(): boolean {
    return this.errors.some(
      (e) =>
        e.extensions?.code === 'FORBIDDEN' ||
        /forbidden|unauthorized|not allowed/i.test(e.message)
    );
  }

  /**
   * True when Wiki.js throttled the call.
   *
   * Worth distinguishing because it is temporary and the caller should simply
   * wait — and because the Wiki.js documentation states there is no API rate
   * limiting at all, so nobody expects it.
   */
  get isRateLimited(): boolean {
    return this.errors.some((e) => /too many requests/i.test(e.message));
  }
}

/**
 * The mutation ran, GraphQL accepted it, and Wiki.js refused it anyway.
 *
 * Wiki.js wraps every mutation result in `responseResult { succeeded, errorCode,
 * slug, message }` and returns HTTP 200 with no `errors` array when it fails.
 * Without this branch a failed `create_page` reports success — the "error
 * swallowed and replaced with a plausible wrong answer" case.
 */
export class WikiJsOperationError extends Error {
  /**
   * The upstream's own sentence, bounded — never the raw one.
   *
   * `message` and `slug` come straight out of `responseResult`, and Wiki.js
   * puts whatever its database said in there: send a top-level comment with a
   * null `replyTo` and the Postgres constraint error comes back with the whole
   * INSERT statement in it. Nothing bounds that upstream, `MAX_RESPONSE_BYTES`
   * is 32 MB, and the result budget does not apply to an error result — so the
   * ceiling belongs here, in the one place every operation failure passes
   * through.
   */
  public readonly detail: string;

  /**
   * The Wiki.js error slug, reduced to the shape a slug actually has.
   *
   * `PageDuplicateCreate` and friends survive this untouched, so
   * `operationHint` still switches on them — but the field is free text on the
   * wire, and it gets interpolated into a sentence this server wrote. A slug
   * carrying a newline could otherwise open a line of its own right next to the
   * marker that says which half of the message came from upstream.
   */
  public readonly slug: string;

  constructor(
    public readonly errorCode: number,
    slug: string,
    detail: string,
    public readonly operation: string
  ) {
    const bounded = sanitizeErrorBody(detail);
    const cleanSlug = slug.replaceAll(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64);
    super(
      `Wiki.js refused ${operation}: ${bounded} (${cleanSlug || 'unknown'}, code ${errorCode})`
    );
    this.detail = bounded;
    this.slug = cleanSlug || 'unknown';
    this.name = 'WikiJsOperationError';
  }
}

/** Thrown when a response is larger than the ceiling that applied to it. */
export class ResponseTooLargeError extends Error {
  constructor(operation: string, limit: number) {
    super(
      `the Wiki.js response for ${operation} exceeds the ${formatLimit(limit)} ` +
        'ceiling and was not read.'
    );
    this.name = 'ResponseTooLargeError';
  }
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Thrown when a response that has to be JSON is not.
 *
 * The single most likely misconfiguration of this server, and it does not look
 * like one. Wiki.js serves its web UI from the same origin as `/graphql` and
 * falls through to the single-page app for anything it does not route — so a
 * URL pointing at a reverse proxy, or at the wrong host entirely, answers
 * **200 with HTML** rather than 404.
 */
export class UnexpectedContentTypeError extends Error {
  constructor(contentType: string) {
    super(
      `Wiki.js answered /graphql with "${contentType || 'no content type'}" ` +
        'instead of JSON. Wiki.js serves its web UI from the same origin and ' +
        'falls back to it for unrouted paths, so an HTML answer with HTTP 200 ' +
        'usually means WIKIJS_URL points at something other than a Wiki.js ' +
        'server, or at a proxy that intercepted the call. Check WIKIJS_URL and ' +
        'try get_site_info.'
    );
    this.name = 'UnexpectedContentTypeError';
  }
}

/**
 * Refuses a header value the HTTP layer would refuse, before it can.
 *
 * undici's refusal is `Headers.append: "Bearer <the whole token>" is an
 * invalid header value.` — a `TypeError` that quotes the value in full and
 * reaches the model through the generic error path. A token with a line break
 * in the middle, which is what a wrapped paste looks like, was printed into
 * the tool result that way. `loadConfig` refuses that shape at startup; this
 * is the check at the header itself, so no path to `fetch` can skip it.
 */
export function assertHeaderValue(name: string, value: string): void {
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    throw new Error(
      `the ${name} header is ${value.length} characters long, above the ` +
        `${MAX_HEADER_VALUE_LENGTH} this server will send — check WIKIJS_TOKEN.`
    );
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error(
        `the ${name} header contains a character outside printable ASCII at ` +
          `position ${i + 1} of ${value.length}, which the HTTP layer refuses — ` +
          'a line break or a non-ASCII character in WIKIJS_TOKEN is the usual cause.'
      );
    }
  }
}

export interface RequestOptions {
  /** Overrides {@link MAX_RESPONSE_BYTES} for operations with a known ceiling. */
  maxBytes?: number;
}

/** Client for the Wiki.js 2.x GraphQL API. */
export class WikiJsApi {
  private readonly config: Config;
  /**
   * Only set when WIKIJS_INSECURE_TLS is enabled. Scopes the relaxed
   * certificate validation to requests against the configured host instead of
   * disabling it process-wide via NODE_TLS_REJECT_UNAUTHORIZED.
   */
  private readonly insecureDispatcher?: Agent;

  constructor(config: Config) {
    this.config = config;
    if (config.insecureTls) {
      this.insecureDispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }
  }

  /** The configured site root, for messages that need to name the instance. */
  get siteRoot(): string | undefined {
    return this.config.url;
  }

  /** The locale page tools assume when the caller did not name one. */
  get defaultLocale(): string {
    return this.config.locale;
  }

  /** The bearer header, checked before the HTTP layer can quote it. */
  private authorization(): string {
    const value = `Bearer ${this.config.token ?? ''}`;
    assertHeaderValue('Authorization', value);
    return value;
  }

  /**
   * Runs a GraphQL document and returns its `data`.
   *
   * `operation` is a short label used in error messages only — never the
   * document itself, which would put the whole query into the model's context
   * on every failure.
   */
  async execute(
    operation: string,
    document: string,
    variables: Record<string, unknown> = {},
    options: RequestOptions = {}
  ): Promise<Record<string, unknown>> {
    // The credentials are only required here, not at startup, so the server can
    // still be started and introspected without them.
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) throw new Error(missingConfigMessage(missing));

    const init: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: this.authorization(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: document, variables }),
      // Never follow a redirect: it would resend the API key to whatever host
      // the upstream points at.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    const url = `${this.config.url ?? ''}/graphql`;
    // The insecure dispatcher requires undici's own fetch; the default path uses
    // the (stubbable) global fetch so tests can intercept it.
    const response = this.insecureDispatcher
      ? await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)
      : await fetch(url, init);

    // The status decides first. A failed answer's body is read under its own
    // small ceiling, so a large error page cannot turn a 401 into a report
    // about size — and the 32 MB ceiling applies only to an answer that is
    // actually the data.
    if (!response.ok) {
      throw new WikiJsApiError(
        response.status,
        await readErrorBody(response as unknown as Response),
        operation
      );
    }

    const limit = options.maxBytes ?? MAX_RESPONSE_BYTES;
    const text = await readCapped(
      response as unknown as Response,
      limit,
      operation
    );

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new UnexpectedContentTypeError(contentType);
    }

    let body: { data?: unknown; errors?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new UnexpectedContentTypeError(`${contentType} (unparseable)`);
    }

    // HTTP 200 is not success in GraphQL. This branch is the whole reason the
    // REST-shaped client from the neighbouring servers could not be reused.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new WikiJsGraphQLError(body.errors, operation);
    }
    if (body.data === null || body.data === undefined) {
      throw new WikiJsGraphQLError(
        [{ message: 'the response carried no data' }],
        operation
      );
    }
    return body.data as Record<string, unknown>;
  }

  /**
   * Uploads a file to the asset store.
   *
   * The one operation Wiki.js 2.x cannot do over GraphQL: `AssetMutation` has
   * list, rename, delete and folder creation, but the upload itself is the
   * editor's own multipart POST to `/u`. Verified against Wiki.js 2.5.314 that
   * it accepts an API key as a bearer token rather than a session cookie.
   */
  async upload(
    filename: string,
    contentType: string,
    data: Uint8Array,
    folderId: number
  ): Promise<void> {
    const missing = missingConfigKeys(this.config);
    if (missing.length > 0) throw new Error(missingConfigMessage(missing));

    const form = new FormData();
    // Wiki.js reads the JSON part first and the file second, both under the
    // same field name — the order is part of the contract, not an accident.
    form.append('mediaUpload', JSON.stringify({ folderId }));
    form.append(
      'mediaUpload',
      new Blob([data as unknown as BlobPart], { type: contentType }),
      filename
    );

    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: this.authorization() },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    const url = `${this.config.url ?? ''}/u`;
    const response = this.insecureDispatcher
      ? await undiciFetch(url, {
          ...init,
          dispatcher: this.insecureDispatcher,
        } as UndiciRequestInit)
      : await fetch(url, init);

    if (!response.ok) {
      throw new WikiJsApiError(
        response.status,
        await readErrorBody(response as unknown as Response),
        'upload_asset'
      );
    }
    const text = await readCapped(
      response as unknown as Response,
      MAX_ERROR_BODY_BYTES,
      'upload_asset'
    );
    // `/u` answers `ok` on success and an error string otherwise, both with 200.
    if (text.trim() !== 'ok') {
      throw new WikiJsApiError(response.status, text, 'upload_asset');
    }
  }
}

/**
 * Unwraps Wiki.js' mutation envelope.
 *
 * Every mutation answers `{ responseResult: { succeeded, errorCode, slug,
 * message } }` and reports failure inside a 200 with no `errors` array. Calling
 * this on every mutation is what keeps a refused write from being reported as a
 * successful one.
 */
export function assertSucceeded(payload: unknown, operation: string): void {
  const result = (payload as { responseResult?: unknown } | null | undefined)
    ?.responseResult as
    | {
        succeeded?: boolean;
        errorCode?: number;
        slug?: string;
        message?: string;
      }
    | null
    | undefined;
  // `== null` covers both: Wiki.js returns a *null* responseResult from some
  // mutations (users.resetPassword does when mail is not configured), and a
  // strict `=== undefined` check would fall through and dereference null.
  if (result == null) {
    throw new WikiJsOperationError(
      0,
      'unknown',
      'the mutation returned no result envelope, which Wiki.js does when the ' +
        'operation could not even be attempted — a password reset with no mail ' +
        'server configured is the usual case',
      operation
    );
  }
  if (result.succeeded === true) return;
  throw new WikiJsOperationError(
    typeof result.errorCode === 'number' ? result.errorCode : 0,
    typeof result.slug === 'string' ? result.slug : 'unknown',
    typeof result.message === 'string' ? result.message : 'no reason given',
    operation
  );
}

/**
 * Reads a response body with a hard byte ceiling.
 *
 * Both halves matter: `content-length` catches an oversized answer before a
 * single byte is read, and the streaming count catches a chunked response,
 * which declares no length at all.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  operation: string
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // Nothing has been read yet, so the body can simply be discarded.
    await response.body?.cancel();
    throw new ResponseTooLargeError(operation, maxBytes);
  }

  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(operation, maxBytes);
    }
    chunks.push(value);
    total += value.byteLength;
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads the body of a failed answer: at most {@link MAX_ERROR_BODY_BYTES},
 * cut rather than refused, and never a reason to throw — the status already
 * is the answer, and a body that cannot be read is an empty hint, not a
 * different error.
 */
async function readErrorBody(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const room = MAX_ERROR_BODY_BYTES - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // Whatever was read is the hint; the status is the answer.
  }
  return Buffer.concat(chunks).toString('utf8');
}
