import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertSucceeded,
  MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  UnexpectedContentTypeError,
  WikiJsApi,
  WikiJsApiError,
  WikiJsGraphQLError,
  WikiJsOperationError,
} from '../src/api.js';
import { ENDPOINT, stubFetch, testConfig, TOKEN } from './harness.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const api = (overrides = {}): WikiJsApi => new WikiJsApi(testConfig(overrides));

describe('WikiJsApi.execute', () => {
  it('posts the document to /graphql with a bearer token', async () => {
    const stub = stubFetch({ 'pages {': { data: { pages: { list: [] } } } });
    await api().execute('t', 'query { pages { list { id } } }', { a: 1 });
    const call = stub.calls[0];
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.variables).toEqual({ a: 1 });
  });

  it('never follows a redirect, which would resend the key elsewhere', async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, options?: RequestInit) => {
        init = options;
        return new Response(JSON.stringify({ data: {} }), {
          headers: { 'content-type': 'application/json' },
        });
      })
    );
    await api().execute('t', 'query { x }');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeDefined();
  });

  it('refuses to run without credentials, with setup instructions', async () => {
    stubFetch({ query: { data: {} } });
    await expect(
      api({ token: undefined }).execute('t', 'query { x }')
    ).rejects.toThrow(/WIKIJS_TOKEN/);
  });

  it('treats HTTP 200 with an errors array as a failure', async () => {
    // The whole reason a REST-shaped client could not be reused: `response.ok`
    // is true here, and a client that trusted it would report success.
    stubFetch({
      query: { status: 200, errors: [{ message: 'Forbidden' }] },
    });
    await expect(api().execute('t', 'query { x }')).rejects.toBeInstanceOf(
      WikiJsGraphQLError
    );
  });

  it('recognises a permission refusal', async () => {
    stubFetch({
      query: {
        errors: [{ message: 'nope', extensions: { code: 'FORBIDDEN' } }],
      },
    });
    const error = await api()
      .execute('t', 'query { x }')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WikiJsGraphQLError);
    expect((error as WikiJsGraphQLError).isForbidden).toBe(true);
    expect((error as WikiJsGraphQLError).isRateLimited).toBe(false);
  });

  it('recognises the undocumented throttle', async () => {
    stubFetch({
      query: {
        errors: [
          { message: 'Too many requests, please try again in 1 seconds.' },
        ],
      },
    });
    const error = (await api()
      .execute('t', 'query { x }')
      .catch((e: unknown) => e)) as WikiJsGraphQLError;
    expect(error.isRateLimited).toBe(true);
  });

  it('rejects a null data payload rather than returning it', async () => {
    stubFetch({ query: { raw: JSON.stringify({ data: null }) } });
    await expect(api().execute('t', 'query { x }')).rejects.toBeInstanceOf(
      WikiJsGraphQLError
    );
  });

  it('reports a non-2xx answer as a transport error', async () => {
    stubFetch({
      query: { status: 502, raw: 'bad gateway', contentType: 'text/plain' },
    });
    const error = (await api()
      .execute('t', 'query { x }')
      .catch((e: unknown) => e)) as WikiJsApiError;
    expect(error).toBeInstanceOf(WikiJsApiError);
    expect(error.status).toBe(502);
  });

  it('names the HTML-instead-of-JSON case, which looks like nothing at all', async () => {
    // Wiki.js serves its SPA from the same origin, so a URL pointing at the
    // wrong host answers 200 with a web page.
    stubFetch({
      query: { raw: '<!doctype html><html></html>', contentType: 'text/html' },
    });
    await expect(api().execute('t', 'query { x }')).rejects.toBeInstanceOf(
      UnexpectedContentTypeError
    );
  });

  it('reports unparseable JSON as the same misconfiguration', async () => {
    stubFetch({ query: { raw: 'not json', contentType: 'application/json' } });
    await expect(api().execute('t', 'query { x }')).rejects.toBeInstanceOf(
      UnexpectedContentTypeError
    );
  });

  it('refuses an oversized response declared by content-length', async () => {
    stubFetch({
      query: {
        data: {},
        headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
      },
    });
    await expect(api().execute('t', 'query { x }')).rejects.toBeInstanceOf(
      ResponseTooLargeError
    );
  });

  it('refuses an oversized chunked response, which declares no length', async () => {
    stubFetch({ query: { raw: 'x'.repeat(5000) } });
    await expect(
      api().execute('t', 'query { x }', {}, { maxBytes: 1000 })
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe('WikiJsApi.upload', () => {
  it('posts multipart to /u and accepts the plain "ok" answer', async () => {
    let url = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        url = String(input);
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response('ok', {
          headers: { 'content-type': 'text/plain' },
        });
      })
    );
    await api().upload('a.png', 'image/png', new Uint8Array([1, 2]), 0);
    expect(url).toBe('https://wiki.example.net/u');
  });

  it('treats a 200 that is not "ok" as a failure', async () => {
    // The upload route answers 200 for both outcomes and says which in the body.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('File is too large.', {
            headers: { 'content-type': 'text/plain' },
          })
      )
    );
    await expect(
      api().upload('a.png', 'image/png', new Uint8Array([1]), 0)
    ).rejects.toBeInstanceOf(WikiJsApiError);
  });
});

describe('assertSucceeded', () => {
  it('passes a succeeded envelope', () => {
    expect(() =>
      assertSucceeded({ responseResult: { succeeded: true } }, 'op')
    ).not.toThrow();
  });

  it('turns a refused mutation into an error, not a silent success', () => {
    const error = (() => {
      try {
        assertSucceeded(
          {
            responseResult: {
              succeeded: false,
              errorCode: 6002,
              slug: 'PageDuplicateCreate',
              message: 'exists',
            },
          },
          'create_page'
        );
      } catch (e) {
        return e as WikiJsOperationError;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(WikiJsOperationError);
    expect(error?.slug).toBe('PageDuplicateCreate');
    expect(error?.errorCode).toBe(6002);
  });

  it('handles a null responseResult, which Wiki.js really returns', () => {
    // users.resetPassword answers this way when no mail server is configured.
    // A strict `=== undefined` check would fall through and dereference null.
    expect(() =>
      assertSucceeded({ responseResult: null }, 'reset_user_password')
    ).toThrow(WikiJsOperationError);
  });

  it('handles a missing payload entirely', () => {
    expect(() => assertSucceeded(undefined, 'op')).toThrow(
      WikiJsOperationError
    );
    expect(() => assertSucceeded(null, 'op')).toThrow(WikiJsOperationError);
  });
});
