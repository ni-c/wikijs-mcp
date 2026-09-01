import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Brings the throwaway Wiki.js from empty to usable, without a browser.
 *
 * Ported from `scripts/sandbox/bootstrap.py`, which had to be a separate
 * process because the smoke script could not import Python. As TypeScript the
 * suite calls it directly, so there is one thing to run rather than two, and a
 * failure here is a failed test rather than a non-zero exit nobody checked.
 *
 * The sequence is: finalize the setup wizard, log in for a JWT, switch the API
 * on, mint a full-access key. Every step is a documented Wiki.js endpoint; the
 * order is the part that is not documented anywhere.
 */

export const ADMIN_EMAIL = 'admin@sandbox.local';
export const ADMIN_PASSWORD = 'sandbox-admin-not-a-secret';

/** The marker `grep_pages` looks for, kept here so the seed owns it. */
export const GREP_MARKER = 'PINEAPPLE';

export interface Sandbox {
  url: string;
  /** A full-access API key, which is what the server is configured with. */
  key: string;
  email: string;
  password: string;
  /** Seeded so the read tools have something that is not the home page. */
  setupPageId: number;
  faqPageId: number;
}

interface GraphQLBody {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

async function graphql(
  url: string,
  query: string,
  variables: object = {},
  token?: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as GraphQLBody;
  if (body.errors !== undefined) {
    throw new Error(
      `Wiki.js GraphQL error: ${JSON.stringify(body.errors).slice(0, 400)}`
    );
  }
  if (body.data === undefined) {
    throw new Error(`Wiki.js returned no data: HTTP ${response.status}`);
  }
  return body.data;
}

/** Retries a step that is only *eventually* available after a restart. */
async function eventually<T>(
  what: string,
  attempt: () => Promise<T>,
  tries = 30
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  throw new Error(`${what} never succeeded: ${String(last)}`);
}

export async function bootstrap(
  url = 'http://127.0.0.1:3010'
): Promise<Sandbox> {
  assertLoopback(url);
  // Wiki.js answers the setup page with a 200 and redirects elsewhere, so any
  // response at all means the HTTP server is listening.
  await waitForHttp(url, { timeoutSeconds: 180 });

  const finalize = await fetch(`${url}/finalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      adminEmail: ADMIN_EMAIL,
      adminPassword: ADMIN_PASSWORD,
      adminPasswordConfirm: ADMIN_PASSWORD,
      siteUrl: url,
      telemetry: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (finalize.status === 404) {
    // Wiki.js does not answer /finalize with "already done" — once it is set
    // up the setup routes are gone entirely and the SPA's 404 page comes back
    // with an HTML body, which reads like a wrong URL rather than a wrong
    // state. Saying so here saves the next person the ten minutes it cost.
    throw new Error(
      'This Wiki.js is already set up, and the suite needs a fresh one: it ' +
        'creates fixtures at fixed paths and deletes them again, so a second ' +
        'run against the same instance would collide with its own leftovers. ' +
        'Run `docker compose -f test/integration/compose.yml down -v` and up ' +
        'again.'
    );
  }
  if (!finalize.ok) {
    const detail = (await finalize.text()).slice(0, 200);
    throw new Error(`finalize failed: HTTP ${finalize.status} — ${detail}`);
  }

  // Wiki.js restarts its master process after finalize. Polling the HTTP port
  // is not enough — it comes back before GraphQL will authenticate — so the
  // login itself is the readiness check.
  await waitForHttp(url, { timeoutSeconds: 180 });

  const login = (await eventually('login', () =>
    graphql(
      url,
      `
        mutation ($u: String!, $p: String!) {
          authentication {
            login(username: $u, password: $p, strategy: "local") {
              jwt
              responseResult {
                succeeded
                errorCode
                message
              }
            }
          }
        }
      `,
      { u: ADMIN_EMAIL, p: ADMIN_PASSWORD }
    )
  )) as {
    authentication: {
      login: { jwt?: string; responseResult: { message: string } };
    };
  };
  const jwt = login.authentication.login.jwt;
  if (jwt === undefined) {
    throw new Error(
      `login failed: ${login.authentication.login.responseResult.message}`
    );
  }

  await graphql(
    url,
    `
      mutation {
        authentication {
          setApiState(enabled: true) {
            responseResult {
              succeeded
              message
            }
          }
        }
      }
    `,
    {},
    jwt
  );

  const minted = (await graphql(
    url,
    `
      mutation ($n: String!) {
        authentication {
          createApiKey(name: $n, expiration: "1y", fullAccess: true) {
            key
            responseResult {
              succeeded
              errorCode
              message
            }
          }
        }
      }
    `,
    { n: 'wikijs-mcp-integration' },
    jwt
  )) as {
    authentication: {
      createApiKey: { key?: string; responseResult: { message: string } };
    };
  };
  const key = minted.authentication.createApiKey.key;
  if (key === undefined) {
    throw new Error(
      `could not mint an API key: ${minted.authentication.createApiKey.responseResult.message}`
    );
  }

  const setupPageId = await seedPage(url, key, {
    path: 'docs/setup',
    title: 'Setup',
    description: 'How to set the thing up',
    content: `# Setup\n\n## First\n\nDo the first thing.\n\n## Then\n\nMarker ${GREP_MARKER}.\n`,
    tags: ['docs'],
  });
  const faqPageId = await seedPage(url, key, {
    path: 'docs/faq',
    title: 'Frequently Asked Questions',
    description: 'Frequently asked',
    content: '# FAQ\n\n## Why\n\nBaseline.\n\n## How\n\nBecause.\n',
    tags: ['docs'],
  });

  return {
    url,
    key,
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    setupPageId,
    faqPageId,
  };
}

interface Seed {
  path: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
}

/** Creates a fixture page directly, so the read tools have something to read. */
async function seedPage(url: string, key: string, seed: Seed): Promise<number> {
  const created = (await graphql(
    url,
    `
      mutation (
        $path: String!
        $title: String!
        $description: String!
        $content: String!
        $tags: [String]!
      ) {
        pages {
          create(
            path: $path
            title: $title
            description: $description
            content: $content
            tags: $tags
            editor: "markdown"
            locale: "en"
            isPublished: true
            isPrivate: false
          ) {
            page {
              id
            }
            responseResult {
              succeeded
              errorCode
              message
            }
          }
        }
      }
    `,
    seed,
    key
  )) as {
    pages: {
      create: { page?: { id: number }; responseResult: { message: string } };
    };
  };
  const id = created.pages.create.page?.id;
  if (id === undefined) {
    throw new Error(
      `could not seed ${seed.path}: ${created.pages.create.responseResult.message}`
    );
  }
  return id;
}

/**
 * Edits a page behind the server's back, over GraphQL directly.
 *
 * The concurrent-edit guard cannot be tested through the tools alone: something
 * that is *not* the model has to save between the model's read and its write.
 * Ported from `scripts/sandbox/conflict.mjs`.
 */
export async function foreignEdit(
  sandbox: Sandbox,
  pageId: number,
  content: string
): Promise<void> {
  const result = (await graphql(
    sandbox.url,
    // `tags` is not optional in practice. Omitting it does not leave the tags
    // alone — Wiki.js dereferences the argument and fails with "Cannot read
    // properties of undefined (reading 'map')", an internal error dressed up
    // as a GraphQL one. The schema declares it nullable.
    `
      mutation (
        $id: Int!
        $content: String!
        $title: String!
        $description: String!
        $tags: [String]!
      ) {
        pages {
          update(
            id: $id
            content: $content
            title: $title
            description: $description
            tags: $tags
            editor: "markdown"
            isPublished: true
            isPrivate: false
          ) {
            responseResult {
              succeeded
              message
            }
          }
        }
      }
    `,
    {
      id: pageId,
      content,
      title: 'Frequently Asked Questions',
      description: 'Frequently asked',
      tags: ['docs'],
    },
    sandbox.key
  )) as {
    pages: {
      update: { responseResult: { succeeded: boolean; message: string } };
    };
  };
  if (!result.pages.update.responseResult.succeeded) {
    throw new Error(
      `foreign edit failed: ${result.pages.update.responseResult.message}`
    );
  }
}

/** Mints a second, limited key, so `revoke_api_key` has something safe to kill. */
export async function mintThrowawayKey(
  sandbox: Sandbox,
  name: string
): Promise<void> {
  const minted = (await graphql(
    sandbox.url,
    `
      mutation ($n: String!) {
        authentication {
          createApiKey(
            name: $n
            expiration: "1y"
            fullAccess: false
            group: 1
          ) {
            key
            responseResult {
              succeeded
              message
            }
          }
        }
      }
    `,
    { n: name },
    sandbox.key
  )) as {
    authentication: {
      createApiKey: { responseResult: { succeeded: boolean; message: string } };
    };
  };
  if (!minted.authentication.createApiKey.responseResult.succeeded) {
    throw new Error(
      `could not mint a throwaway key: ${minted.authentication.createApiKey.responseResult.message}`
    );
  }
}
