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

const complete = {
  WIKIJS_URL: 'https://wiki.example.com',
  WIKIJS_TOKEN: 'secret',
};

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    expect(loadConfig(env({ ...complete })).elicitation).toBe(true);
    expect(loadConfig(env({ ...complete, ELICITATION: '' })).elicitation).toBe(
      true
    );
  });

  it('is switched off by "false", in any casing or padding', () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(
        loadConfig(env({ ...complete, ELICITATION: raw })).elicitation,
        raw
      ).toBe(false);
    }
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them.
    for (const raw of ['1', 'off', 'no']) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      expect(() => loadConfig(env({ ...complete, ELICITATION: raw }))).toThrow(
        'exit'
      );
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(error.mock.calls[0]?.[0] ?? '');
      expect(message, raw).toContain('ELICITATION');
      expect(message, raw).toContain('"true"');
      expect(message, raw).toContain('"false"');
      vi.restoreAllMocks();
    }
  });

  it('has already wiped the credential by the time it can exit', () => {
    // parseElicitation sits *after* the delete on purpose. An exit above it
    // would leave the credential in the environment for whatever a crash
    // reporter or an inspector does next — which is exactly what that delete
    // exists to prevent, and its comment says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({ ...complete, ELICITATION: 'nonsense' });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.WIKIJS_TOKEN).toBeUndefined();
    vi.restoreAllMocks();
  });
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

  it('honours anything an operator plausibly meant by "read only"', () => {
    // A protection switch is read leniently. `WIKIJS_READ_ONLY=1` from a shell
    // script and `=yes` from a compose file are both somebody saying "do not
    // let it write", and a parser that answers "that is not the word I wanted"
    // by registering the write tools is answering the wrong question.
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'Yes', ' true ']) {
      const config = loadConfig(
        env({
          WIKIJS_URL: 'https://w.example',
          WIKIJS_TOKEN: 't',
          WIKIJS_READ_ONLY: raw,
        })
      );
      expect(config.readOnly, raw).toBe(true);
    }
  });

  it('still leaves the write tools on when the value means nothing', () => {
    for (const raw of ['', ' ', 'false', 'no', '0', 'off', 'ja']) {
      const config = loadConfig(
        env({
          WIKIJS_URL: 'https://w.example',
          WIKIJS_TOKEN: 't',
          WIKIJS_READ_ONLY: raw,
        })
      );
      expect(config.readOnly, JSON.stringify(raw)).toBe(false);
    }
  });

  it('reads the switch that removes a protection strictly instead', () => {
    // The asymmetry is the point: WIKIJS_INSECURE_TLS stops certificates being
    // verified, so a typo there must fail towards verifying them.
    for (const raw of ['yes', '1', 'TRUE', ' true ']) {
      const config = loadConfig(
        env({
          WIKIJS_URL: 'https://w.example',
          WIKIJS_TOKEN: 't',
          WIKIJS_INSECURE_TLS: raw,
        })
      );
      expect(config.insecureTls, raw).toBe(false);
    }
    expect(
      loadConfig(
        env({
          WIKIJS_URL: 'https://w.example',
          WIKIJS_TOKEN: 't',
          WIKIJS_INSECURE_TLS: 'true',
        })
      ).insecureTls
    ).toBe(true);
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

  it.each([
    ['bracketed IPv6', 'http://[::1]:3000'],
    ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]:3000'],
    ['a fully qualified localhost', 'http://localhost.:3000'],
  ])('treats loopback spelled as %s as loopback', (_, url) => {
    // URL.hostname hands back '[::1]' with its brackets and normalises
    // ::ffff:127.0.0.1 to '[::ffff:7f00:1]'. The comparison this replaced
    // checked for a bare '::1' and so warned about every one of these.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ WIKIJS_URL: url, WIKIJS_TOKEN: 't' }));
    expect(error.mock.calls.flat().join(' ')).not.toContain('unencrypted');
    error.mockRestore();
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
