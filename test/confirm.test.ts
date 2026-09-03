import { afterEach, describe, expect, it, vi } from 'vitest';

import { identifier } from '../src/resource-key.js';
import { connect, stubFetch, testConfig } from './harness.js';

/** What a Wiki.js mutation returns when it worked. */
const OK = { responseResult: { succeeded: true } };

afterEach(() => {
  vi.useRealTimers();
});

describe('identifier', () => {
  it('passes a plain page path', () => {
    expect(identifier('docs/setup', 'page path')).toBe('docs/setup');
  });

  it('refuses whitespace, quotes and control characters', () => {
    for (const bad of ['a b', 'a"b', "a'b", 'a`b', 'a\nb', 'a\u0000b']) {
      expect(() => identifier(bad, 'page path')).toThrow(/refusing to name/);
    }
  });
});

describe('the guard, end to end through the real server', () => {
  // These used to call `guarded` directly. It now needs a live server and a
  // request context, and driving it through the server is the better test
  // anyway: what this repository has to prove is the wiring, not the dance —
  // the dance belongs to mcp-approval and is tested there.

  const routes = {
    'query GetUser': {
      data: { users: { single: { id: 1, name: 'Ada', groups: [] } } },
    },
    'mutation DeleteUser': { data: { users: { delete: OK } } },
  };

  it('asks the user, and acts once they accept', async () => {
    const stub = stubFetch(routes);
    const { call, prompts, close } = await connect(testConfig(), 'accept');
    const result = await call('delete_user', {
      user_id: 1,
      replace_with_user_id: 2,
    });
    expect(prompts).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(stub.calls.length).toBeGreaterThan(0);
    await close();
  });

  it('does nothing when the user declines', async () => {
    stubFetch(routes);
    const { call, close } = await connect(testConfig(), 'decline');
    const result = await call('delete_user', {
      user_id: 1,
      replace_with_user_id: 2,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('declined');
    await close();
  });

  it('offers no token to a client it can ask properly', async () => {
    // The control: the token path is unchanged, so a server that silently never
    // asked would still pass every other confirmation test in this repository.
    stubFetch(routes);
    const { call, close } = await connect(testConfig(), 'decline');
    const result = await call('delete_user', {
      user_id: 1,
      replace_with_user_id: 2,
    });
    expect(JSON.stringify(result)).not.toContain('confirm_token');
    await close();
  });

  it('refuses a token issued for different arguments, with the reason', async () => {
    stubFetch(routes);
    const { call, text, close } = await connect();
    const prompt = await text('delete_user', {
      user_id: 1,
      replace_with_user_id: 2,
    });
    const token = /confirm_token="([0-9a-f]{32})"/.exec(prompt)?.[1];
    expect(token).toBeDefined();
    const wrong = await call('delete_user', {
      user_id: 3,
      replace_with_user_id: 2,
      confirm_token: token,
    });
    expect(wrong.isError).toBe(true);
    expect(JSON.stringify(wrong)).toContain('issued for different arguments');
    await close();
  });
});
