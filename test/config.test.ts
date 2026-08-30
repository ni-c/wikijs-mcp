import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCALE,
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
} from '../src/config.js';

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { ...values } as NodeJS.ProcessEnv;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('reads the documented variables', () => {
    const config = loadConfig(
      env({
        WIKIJS_URL: 'https://wiki.example.net',
        WIKIJS_TOKEN: 'secret',
        WIKIJS_LOCALE: 'de',
        WIKIJS_READ_ONLY: 'true',
        WIKIJS_INSECURE_TLS: 'true',
        WIKIJS_ALLOWED_PATHS: 'docs',
        WIKIJS_ALLOW_TOOLS: 'get_page',
        WIKIJS_DENY_TOOLS: 'delete_page',
      })
    );
    expect(config).toMatchObject({
      url: 'https://wiki.example.net',
      token: 'secret',
      locale: 'de',
      readOnly: true,
      insecureTls: true,
      allowedPaths: 'docs',
      allowTools: 'get_page',
      denyTools: 'delete_page',
    });
  });

  it('accepts WIKIJS_API_KEY as an alias, so a migration is not an env rewrite', () => {
    const config = loadConfig(
      env({ WIKIJS_URL: 'https://wiki.example.net', WIKIJS_API_KEY: 'legacy' })
    );
    expect(config.token).toBe('legacy');
  });

  it('prefers WIKIJS_TOKEN when both are set', () => {
    const config = loadConfig(
      env({
        WIKIJS_URL: 'https://wiki.example.net',
        WIKIJS_TOKEN: 'primary',
        WIKIJS_API_KEY: 'legacy',
      })
    );
    expect(config.token).toBe('primary');
  });

  it('deletes both credential variables from the environment', () => {
    const environment = env({
      WIKIJS_URL: 'https://wiki.example.net',
      WIKIJS_TOKEN: 'secret',
      WIKIJS_API_KEY: 'legacy',
    });
    loadConfig(environment);
    expect(environment.WIKIJS_TOKEN).toBeUndefined();
    expect(environment.WIKIJS_API_KEY).toBeUndefined();
  });

  it('deletes the credentials even when the URL is missing and it returns early', () => {
    const environment = env({
      WIKIJS_TOKEN: 'secret',
      WIKIJS_API_KEY: 'legacy',
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(environment);
    expect(environment.WIKIJS_TOKEN).toBeUndefined();
    expect(environment.WIKIJS_API_KEY).toBeUndefined();
  });

  it('falls back to the default locale, including for an empty value', () => {
    expect(
      loadConfig(env({ WIKIJS_URL: 'https://w.example', WIKIJS_TOKEN: 't' }))
        .locale
    ).toBe(DEFAULT_LOCALE);
    expect(
      loadConfig(
        env({
          WIKIJS_URL: 'https://w.example',
          WIKIJS_TOKEN: 't',
          WIKIJS_LOCALE: '   ',
        })
      ).locale
    ).toBe(DEFAULT_LOCALE);
  });

  it('treats booleans as exactly "true", never as truthiness', () => {
    const config = loadConfig(
      env({
        WIKIJS_URL: 'https://w.example',
        WIKIJS_TOKEN: 't',
        WIKIJS_READ_ONLY: '1',
        WIKIJS_INSECURE_TLS: 'yes',
      })
    );
    expect(config.readOnly).toBe(false);
    expect(config.insecureTls).toBe(false);
  });

  it('starts without credentials so tools/list still works', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(env({}));
    expect(config.url).toBeUndefined();
    expect(config.token).toBeUndefined();
    expect(error).toHaveBeenCalled();
    expect(missingConfigKeys(config)).toEqual(['WIKIJS_URL', 'WIKIJS_TOKEN']);
  });

  it('strips trailing slashes and a /graphql suffix', () => {
    expect(
      loadConfig(
        env({ WIKIJS_URL: 'https://w.example/graphql', WIKIJS_TOKEN: 't' })
      ).url
    ).toBe('https://w.example');
    expect(
      loadConfig(
        env({ WIKIJS_URL: 'https://w.example/wiki//', WIKIJS_TOKEN: 't' })
      ).url
    ).toBe('https://w.example/wiki');
  });

  it('drops a query string, which would otherwise land in front of /graphql', () => {
    expect(
      loadConfig(
        env({ WIKIJS_URL: 'https://w.example/?x=1', WIKIJS_TOKEN: 't' })
      ).url
    ).toBe('https://w.example');
  });

  it('exits on a malformed URL without echoing the value', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The mock throws rather than returning: the real process.exit never comes
    // back, and a mock that does lets execution fall into code the production
    // path can never reach.
    const exit = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);
    expect(() =>
      loadConfig(env({ WIKIJS_URL: 'not a url', WIKIJS_TOKEN: 'super-secret' }))
    ).toThrow('exit:1');
    expect(exit).toHaveBeenCalledWith(1);
    const printed = error.mock.calls.flat().join(' ');
    expect(printed).not.toContain('super-secret');
    expect(printed).not.toContain('not a url');
  });

  it('rejects a non-http scheme and credentials in the URL', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((
      code?: number
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);
    expect(() =>
      loadConfig(env({ WIKIJS_URL: 'ftp://w.example', WIKIJS_TOKEN: 't' }))
    ).toThrow('exit:1');
    expect(() =>
      loadConfig(
        env({ WIKIJS_URL: 'https://user:pass@w.example', WIKIJS_TOKEN: 't' })
      )
    ).toThrow('exit:1');
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it('warns about plain http to a remote host but not to loopback', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ WIKIJS_URL: 'http://127.0.0.1:3000', WIKIJS_TOKEN: 't' }));
    expect(error.mock.calls.flat().join(' ')).not.toContain('unencrypted');
    loadConfig(
      env({ WIKIJS_URL: 'http://wiki.example.net', WIKIJS_TOKEN: 't' })
    );
    expect(error.mock.calls.flat().join(' ')).toContain('unencrypted');
  });
});

describe('missingConfigMessage', () => {
  it('names both spellings of the credential variable', () => {
    const message = missingConfigMessage(['WIKIJS_TOKEN']);
    expect(message).toContain('WIKIJS_TOKEN');
    expect(message).toContain('WIKIJS_API_KEY');
    expect(message).toContain('API Access');
  });
});
