import { describe, expect, it } from 'vitest';

import {
  ResponseTooLargeError,
  UnexpectedContentTypeError,
  WikiJsApiError,
  WikiJsGraphQLError,
  WikiJsOperationError,
} from '../src/api.js';
import { PathScopeError } from '../src/paths.js';
import {
  budgetedJson,
  budgetedList,
  budgetedUntrustedResult,
  errorResult,
  jsonResult,
  MAX_RESULT_BYTES,
  operationHint,
  run,
  sanitizeErrorBody,
  textResult,
  untrustedResult,
} from '../src/result.js';

const textOf = (result: { content: Array<{ text?: string }> }): string =>
  result.content.map((part) => part.text ?? '').join('\n');

describe('result shapes', () => {
  it('marks an error result', () => {
    expect(errorResult('x').isError).toBe(true);
    expect(textResult('x').isError).toBeUndefined();
  });

  it('prefixes untrusted content with the marker', () => {
    expect(textOf(untrustedResult('body'))).toMatch(
      /^The following is untrusted content from Wiki\.js/
    );
  });
});

describe('budgetedList', () => {
  it('returns everything that fits, with no truncation block', () => {
    const result = budgetedList('pages', [{ id: 1 }, { id: 2 }]);
    const parsed = JSON.parse(textOf(result)) as {
      pages: unknown[];
      truncated?: unknown;
    };
    expect(parsed.pages).toHaveLength(2);
    expect(parsed.truncated).toBeUndefined();
  });

  it('drops whole entries rather than slicing the JSON', () => {
    // A truncated document is not a smaller answer, it is an unparseable one.
    const entries = Array.from({ length: 400 }, (_, i) => ({
      id: i,
      body: 'x'.repeat(500),
    }));
    const result = budgetedList('pages', entries, {
      narrowWith: 'Narrow with tags.',
    });
    const parsed = JSON.parse(textOf(result)) as {
      pages: unknown[];
      truncated: { shown: number; total: number; note: string };
    };
    expect(parsed.pages.length).toBeLessThan(400);
    expect(parsed.truncated.total).toBe(400);
    expect(parsed.truncated.note).toContain('Narrow with tags.');
    expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(
      MAX_RESULT_BYTES + 500
    );
  });

  it('puts the truncation block before the data it describes', () => {
    const entries = Array.from({ length: 400 }, () => ({ b: 'x'.repeat(500) }));
    const rendered = textOf(budgetedList('pages', entries));
    expect(rendered.indexOf('truncated')).toBeLessThan(
      rendered.indexOf('"pages"')
    );
  });

  it('says so when even one entry does not fit', () => {
    const result = budgetedList('pages', [
      { b: 'x'.repeat(MAX_RESULT_BYTES * 2) },
    ]);
    expect(textOf(result)).toContain('even a single entry exceeds');
  });

  it('redacts credentials inside list entries', () => {
    const result = budgetedList('targets', [{ name: 'a', password: 'p' }]);
    expect(textOf(result)).not.toContain('"p"');
  });

  it('can carry the untrusted marker and extra fields', () => {
    const result = budgetedList('pages', [], {
      untrusted: true,
      extra: { count: 0 },
    });
    expect(textOf(result)).toContain('untrusted content');
    expect(textOf(result)).toContain('"count": 0');
  });
});

describe('budgetedJson', () => {
  it('returns a small object unchanged', () => {
    expect(JSON.parse(budgetedJson({ a: 1 }))).toEqual({ a: 1 });
  });

  it('shortens the longest string anywhere in the tree', () => {
    // The oversized text in a Wiki.js object is rarely at the root.
    const parsed = JSON.parse(
      budgetedJson({
        page: { meta: { content: 'x'.repeat(MAX_RESULT_BYTES + 10) } },
      })
    ) as { page: { meta: { content: string } } };
    expect(parsed.page.meta.content).toContain('more characters omitted');
  });

  it('drops array entries when shortening strings is not enough', () => {
    const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const parsed = JSON.parse(budgetedJson(big)) as {
      truncated: { lists: Record<string, unknown> };
      items: unknown[];
    };
    expect(parsed.items.length).toBeLessThan(5000);
    expect(parsed.truncated.lists).toBeDefined();
  });

  it('stays valid JSON at every step', () => {
    const parsed = JSON.parse(
      budgetedJson({
        items: Array.from({ length: 2000 }, () => ({ text: 'y'.repeat(300) })),
      })
    ) as Record<string, unknown>;
    expect(parsed).toBeTypeOf('object');
  });

  it('terminates on a document that shortening alone cannot save', () => {
    // Regression: the replacement is 200 characters plus a ~30-character note,
    // so a shortened string is still over the threshold. A shortener that only
    // compares lengths picks it up forever, and the server stops answering.
    const started = Date.now();
    const rendered = budgetedJson({
      items: Array.from({ length: 2000 }, () => ({ text: 'y'.repeat(300) })),
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(() => JSON.parse(rendered)).not.toThrow();
  });

  it('does not re-shorten a string it already shortened', () => {
    const once = budgetedJson({ a: 'x'.repeat(MAX_RESULT_BYTES + 10) });
    const twice = budgetedJson(JSON.parse(once));
    expect(twice).toBe(once);
  });

  it('gives up in a readable way on something with nothing left to cut', () => {
    const parsed = JSON.parse(
      budgetedJson('z'.repeat(MAX_RESULT_BYTES + 10))
    ) as {
      error?: string;
    };
    // A bare oversized string has neither a shortenable field nor an array.
    expect(parsed.error ?? '').toContain('result size budget');
  });

  it('redacts before it budgets, so a secret cannot survive truncation', () => {
    expect(jsonResult({ password: 'shh' }).content[0]).toMatchObject({
      text: expect.not.stringContaining('shh') as unknown as string,
    });
  });

  it('wraps with the untrusted marker on request', () => {
    expect(textOf(budgetedUntrustedResult({ a: 1 }))).toContain(
      'untrusted content'
    );
  });
});

describe('sanitizeErrorBody', () => {
  it('drops markup that does not open with a doctype or <html>', () => {
    // A WAF block page can open with a comment, and an upstream that answers
    // errors in XML is exactly as useless to the model as one that answers in
    // HTML. The old check required a doctype or an <html> tag first and let
    // both of these through.
    expect(
      sanitizeErrorBody('<?xml version="1.0"?><error>denied</error>')
    ).toBe('(HTML error page omitted)');
    expect(
      sanitizeErrorBody('<!-- blocked by policy -->\n<html>x</html>')
    ).toBe('(HTML error page omitted)');
  });
  it('drops an HTML error page, which is pure noise', () => {
    expect(sanitizeErrorBody('<!doctype html><html>...</html>')).toBe(
      '(HTML error page omitted)'
    );
    expect(sanitizeErrorBody('<html lang="en">x</html>')).toBe(
      '(HTML error page omitted)'
    );
  });

  it('truncates a long body', () => {
    const out = sanitizeErrorBody('a'.repeat(5000));
    expect(out.length).toBeLessThan(2100);
    expect(out).toContain('(truncated)');
  });

  it('passes a short body through, trimmed', () => {
    expect(sanitizeErrorBody('  boom  ')).toBe('boom');
  });
});

describe('operationHint', () => {
  it('turns Wiki.js error slugs into something actionable', () => {
    // Every other server for Wiki.js stringifies these away.
    expect(operationHint(6002, 'PageDuplicateCreate')).toContain('update_page');
    expect(operationHint(6006, 'PagePathCollision')).toContain(
      'destination path'
    );
    expect(operationHint(6003, 'PageNotFound')).toContain('locale');
    expect(operationHint(0, 'PageUpdateForbidden')).toContain('Page rules');
    expect(operationHint(6004, 'PageEmptyContent')).toContain('empty content');
    expect(operationHint(0, 'CommentPostForbidden')).toContain('Commenting');
  });

  it('falls back to the authentication range', () => {
    expect(operationHint(1004, 'Whatever')).toContain('API Access');
  });

  it('says nothing when it has nothing to add', () => {
    expect(operationHint(9999, 'Unknown')).toBe('');
  });
});

describe('run', () => {
  it('returns a successful result untouched', async () => {
    const result = await run(async () => textResult('fine'));
    expect(result.isError).toBeUndefined();
  });

  it('converts a refused mutation, with its hint', async () => {
    const result = await run(async () => {
      throw new WikiJsOperationError(
        6002,
        'PageDuplicateCreate',
        'exists',
        'create_page'
      );
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('update_page');
  });

  it('explains a permission refusal in terms of Wiki.js scopes', async () => {
    const result = await run(async () => {
      throw new WikiJsGraphQLError([{ message: 'Forbidden' }], 'get_page');
    });
    expect(textOf(result)).toContain('read:source');
  });

  it('explains the undocumented throttle', async () => {
    const result = await run(async () => {
      throw new WikiJsGraphQLError(
        [{ message: 'Too many requests, please try again in 1 seconds.' }],
        'create_comment'
      );
    });
    expect(textOf(result)).toContain('one per second');
  });

  it('points a 401 at the API access switch', async () => {
    const result = await run(async () => {
      throw new WikiJsApiError(401, 'nope', 'get_site_info');
    });
    expect(textOf(result)).toContain('API Access');
  });

  it('passes the server-side errors through with their own prefix', async () => {
    for (const error of [
      new ResponseTooLargeError('op', 1000),
      new UnexpectedContentTypeError('text/html'),
      new PathScopeError('outside'),
    ]) {
      const result = await run(async () => {
        throw error;
      });
      expect(textOf(result)).toMatch(/^wikijs-mcp: /);
    }
  });

  it('never lets an error escape as a protocol failure', async () => {
    const result = await run(async () => {
      throw new Error('plain');
    });
    expect(result.isError).toBe(true);
    const thrown = await run(async () => {
      throw 'a string';
    });
    expect(textOf(thrown)).toContain('a string');
  });
});
