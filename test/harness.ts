import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { vi } from 'vitest';

import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

export const SITE = 'https://wiki.example.net';
export const ENDPOINT = `${SITE}/graphql`;
export const TOKEN = 'test-api-key';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: SITE,
    token: TOKEN,
    locale: 'en',
    insecureTls: false,
    readOnly: false,
    allowedPaths: undefined,
    allowTools: undefined,
    denyTools: undefined,
    ...overrides,
  };
}

export interface Recorded {
  url: string;
  headers: Record<string, string>;
  /** The GraphQL document, or the raw body for the upload route. */
  query: string;
  variables: Record<string, unknown>;
  body: unknown;
}

export interface Reply {
  status?: number;
  /** Returned under `data`. */
  data?: unknown;
  /** Returned as the GraphQL `errors` array. */
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  /** Overrides the whole body, for malformed-answer tests. */
  raw?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export type Handler = Reply | ((request: Recorded) => Reply);

/**
 * Routes are keyed by a substring of the GraphQL document.
 *
 * Everything goes to the same URL in GraphQL, so there is no path to route on.
 * Keys are matched longest-first, which keeps `pages { single` from shadowing
 * `pages { singleByPath` no matter what order the object literal is written in.
 */
export type Routes = Record<string, Handler>;

export interface FetchStub {
  calls: Recorded[];
}

/**
 * Replaces global fetch with a router over canned GraphQL replies.
 *
 * A document matching no route fails the test loudly rather than answering with
 * an empty object: a tool that quietly queried the wrong field would otherwise
 * pass every assertion about its output.
 */
export function stubFetch(routes: Routes = {}): FetchStub {
  const calls: Recorded[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        (init?.headers ?? {}) as Record<string, string>
      )) {
        headers[key.toLowerCase()] = value;
      }

      let query = '';
      let variables: Record<string, unknown> = {};
      let body: unknown = init?.body;
      if (typeof init?.body === 'string') {
        try {
          const parsed = JSON.parse(init.body) as {
            query?: string;
            variables?: Record<string, unknown>;
          };
          query = parsed.query ?? '';
          variables = parsed.variables ?? {};
          body = parsed;
        } catch {
          query = init.body;
        }
      }

      const recorded: Recorded = { url, headers, query, variables, body };
      calls.push(recorded);

      const key = keys.find((candidate) => query.includes(candidate));
      if (key === undefined) {
        throw new Error(
          `no stub route matches this document:\n${query.slice(0, 400)}`
        );
      }
      const handler = routes[key] as Handler;
      const reply = typeof handler === 'function' ? handler(recorded) : handler;

      const payload =
        reply.raw ??
        JSON.stringify({
          ...(reply.data !== undefined ? { data: reply.data } : {}),
          ...(reply.errors !== undefined ? { errors: reply.errors } : {}),
        });

      return new Response(payload, {
        status: reply.status ?? 200,
        headers: {
          'content-type': reply.contentType ?? 'application/json',
          ...reply.headers,
        },
      });
    })
  );

  return { calls };
}

/** Connects an in-memory client to a server built from `config`. */
export async function connect(config: Config = testConfig()): Promise<{
  client: Client;
  call: (
    name: string,
    args?: Record<string, unknown>
  ) => Promise<CallToolResult>;
  text: (name: string, args?: Record<string, unknown>) => Promise<string>;
  json: (name: string, args?: Record<string, unknown>) => Promise<never>;
  close: () => Promise<void>;
}> {
  const server = createServer(config);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  const call = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;

  const text = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<string> => {
    const result = await call(name, args);
    return result.content
      .map((part) => ('text' in part ? part.text : ''))
      .join('\n');
  };

  const json = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<never> => {
    const raw = await text(name, args);
    const start = raw.indexOf('{');
    if (start === -1)
      throw new Error(`no JSON in result: ${raw.slice(0, 200)}`);
    return JSON.parse(raw.slice(start)) as never;
  };

  return { client, call, text, json, close: () => client.close() };
}

/** Names of the tools a server built from `config` actually registers. */
export async function toolNames(config: Config): Promise<string[]> {
  const { client, close } = await connect(config);
  const { tools } = await client.listTools();
  await close();
  return tools.map((tool) => tool.name);
}

/** Runs a guarded tool through its confirmation dance and returns the result. */
export async function confirmed(
  text: (name: string, args?: Record<string, unknown>) => Promise<string>,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const prompt = await text(name, args);
  const token = /confirm_token="([0-9a-f]{32})"/.exec(prompt)?.[1];
  if (token === undefined) {
    throw new Error(`${name} offered no confirmation token: ${prompt}`);
  }
  return text(name, { ...args, confirm_token: token });
}
