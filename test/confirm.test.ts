import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfirmationStore,
  confirmationPrompt,
  identifier,
  setResourceKey,
} from '../src/confirm.js';
import { guarded } from '../src/guard.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { textResult } from '../src/result.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ConfirmationStore', () => {
  it('issues a 32-character hex token and consumes it once', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete_page:abc');
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(store.consume('delete_page:abc', token)).toBe(true);
    expect(store.consume('delete_page:abc', token)).toBe(false);
  });

  it('refuses a token issued for a different resource', () => {
    const store = new ConfirmationStore();
    const token = store.issue('delete_page:one');
    expect(store.consume('delete_page:two', token)).toBe(false);
  });

  it('refuses a wrong or absent token', () => {
    const store = new ConfirmationStore();
    store.issue('r');
    expect(store.consume('r', 'f'.repeat(32))).toBe(false);
    expect(store.consume('r', undefined)).toBe(false);
  });

  it('expires a token and drops the entry', () => {
    vi.useFakeTimers();
    const store = new ConfirmationStore(1000);
    const token = store.issue('r');
    vi.advanceTimersByTime(1001);
    expect(store.consume('r', token)).toBe(false);
  });

  it('reports its lifetime in minutes for the prompt', () => {
    expect(new ConfirmationStore(5 * 60_000).ttlMinutes).toBe(5);
  });

  it('bounds the pending map so refused calls cannot grow it forever', () => {
    const store = new ConfirmationStore();
    const first = store.issue('r0');
    for (let i = 1; i <= 100; i++) store.issue(`r${i}`);
    expect(store.consume('r0', first)).toBe(false);
  });
});

describe('setResourceKey', () => {
  it('binds a token to the exact set of targets', () => {
    // Without the fingerprint a confirmation for ["a"] would also execute
    // ["a","b"]: the model chooses the second list and only the operation name
    // would have been checked.
    expect(setResourceKey('op', ['a'])).not.toBe(
      setResourceKey('op', ['a', 'b'])
    );
  });

  it('is order-independent, because the set is what matters', () => {
    expect(setResourceKey('op', ['a', 'b'])).toBe(
      setResourceKey('op', ['b', 'a'])
    );
  });

  it('separates operations that share a target', () => {
    expect(setResourceKey('delete_page', ['1'])).not.toBe(
      setResourceKey('move_page', ['1'])
    );
  });
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

describe('confirmationPrompt', () => {
  it('names the tool, the token and the lifetime', () => {
    const text = confirmationPrompt(
      'delete page 1',
      'It is gone.',
      'delete_page',
      'a'.repeat(32),
      5
    );
    expect(text).toContain('This will delete page 1');
    expect(text).toContain('confirm_token="' + 'a'.repeat(32) + '"');
    expect(text).toContain('delete_page');
    expect(text).toContain('5 minutes');
  });

  it('refuses to build a prompt containing a control character', () => {
    expect(() =>
      confirmationPrompt('do\u0007thing', 'x', 't', 'a'.repeat(32), 5)
    ).toThrow(/control character/);
  });
});

/** The token out of a confirmation prompt, read from the text, not from JSON. */
function tokenOf(result: CallToolResult): string {
  const text = result.content
    .map((part) => ('text' in part ? part.text : ''))
    .join('');
  const token = /confirm_token="([0-9a-f]{32})"/.exec(text)?.[1];
  if (token === undefined) throw new Error(`no token in: ${text}`);
  return token;
}

describe('guarded', () => {
  const options = {
    tool: 'delete_page',
    targets: ['1'],
    what: 'delete page 1',
    consequence: 'It is permanent.',
  };

  it('offers a token on the first call and does not act', async () => {
    const store = new ConfirmationStore();
    const perform = vi.fn(async () => textResult('done'));
    const result = await guarded(
      store,
      { ...options, confirmToken: undefined },
      perform
    );
    expect(perform).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('confirm_token');
  });

  it('acts on the second call with the issued token', async () => {
    const store = new ConfirmationStore();
    const perform = vi.fn(async () => textResult('done'));
    const first = await guarded(
      store,
      { ...options, confirmToken: undefined },
      perform
    );
    const token = tokenOf(first);
    await guarded(store, { ...options, confirmToken: token }, perform);
    expect(perform).toHaveBeenCalledOnce();
  });

  it('distinguishes a wrong token from a missing one', async () => {
    const store = new ConfirmationStore();
    const perform = vi.fn(async () => textResult('done'));
    const result = await guarded(
      store,
      { ...options, confirmToken: 'b'.repeat(32) },
      perform
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      'without a token to get a new one'
    );
    expect(perform).not.toHaveBeenCalled();
  });

  it('will not execute a token issued for different arguments', async () => {
    const store = new ConfirmationStore();
    const perform = vi.fn(async () => textResult('done'));
    const first = await guarded(
      store,
      { ...options, targets: ['1'], confirmToken: undefined },
      perform
    );
    const token = tokenOf(first);
    const result = await guarded(
      store,
      { ...options, targets: ['2'], confirmToken: token },
      perform
    );
    expect(result.isError).toBe(true);
    expect(perform).not.toHaveBeenCalled();
  });
});
