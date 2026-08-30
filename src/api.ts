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
  constructor(
    public readonly errors: GraphQLErrorEntry[],
    public readonly operation: string
  ) {
    super(
      `Wiki.js rejected ${operation}: ${errors.map((e) => e.message).join('; ')}`
    );
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
  constructor(
    public readonly errorCode: number,
    public readonly slug: string,
    detail: string,
    public readonly operation: string
  ) {
    super(
      `Wiki.js refused ${operation}: ${detail} (${slug}, code ${errorCode})`
    );
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
        Authorization: `Bearer ${this.config.token ?? ''}`,
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

    const limit = options.maxBytes ?? MAX_RESPONSE_BYTES;
    const text = await readCapped(
      response as unknown as Response,
      limit,
      operation
    );

    if (!response.ok) {
      throw new WikiJsApiError(response.status, text, operation);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new UnexpectedContentTypeError(contentType);
    }

    let body: { data?: unknown; errors?: GraphQLErrorEntry[] };
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
      headers: { Authorization: `Bearer ${this.config.token ?? ''}` },
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

    const text = await readCapped(
      response as unknown as Response,
      64 * 1024,
      'upload_asset'
    );
    if (!response.ok) {
      throw new WikiJsApiError(response.status, text, 'upload_asset');
    }
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
    result.errorCode ?? 0,
    result.slug ?? 'unknown',
    result.message ?? 'no reason given',
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
