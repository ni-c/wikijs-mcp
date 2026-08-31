import { z } from 'zod';

/**
 * Shared parameter schemas.
 *
 * Everything a tool accepts is defined once, here, with the upstream's quirks
 * written into the description. Two tools that take "a page path" must not
 * disagree about what one is.
 */

/** Wiki.js ids are 32-bit signed integers in Postgres; keep them sane regardless. */
export const idParam = z
  .number()
  .int()
  .min(1, 'ids start at 1')
  .max(Number.MAX_SAFE_INTEGER)
  .describe('Numeric Wiki.js id.');

/**
 * A page path.
 *
 * Wiki.js paths are slash-separated, without a leading or trailing slash and
 * without a locale prefix — the locale is a separate argument, and `en/foo` is
 * a page literally called "en/foo". This is the single most common mistake when
 * copying a path out of a browser URL, so it is rejected rather than guessed at.
 */
export const pagePathParam = z
  .string()
  .trim()
  .min(1, 'a page path cannot be empty')
  .max(2048, 'a page path cannot be longer than 2048 characters')
  .refine((value) => !value.startsWith('/') && !value.endsWith('/'), {
    message:
      'a page path has no leading or trailing slash — use "docs/setup", not "/docs/setup/"',
  })
  .refine((value) => !value.split('/').some((part) => part === '..'), {
    message: 'a page path may not contain ".."',
  })
  // eslint-disable-next-line no-control-regex -- matching them is the point
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'a page path may not contain control characters',
  })
  .describe(
    'Page path without a leading slash and without the locale prefix, e.g. ' +
      '"docs/setup". A browser URL looks like /en/docs/setup — drop the "en/", ' +
      'it is the locale argument. (Not enforced: "ci/", "db/" and "qa/" are ' +
      'perfectly good first segments that happen to look like locale codes.)'
  );

/**
 * A locale code.
 *
 * Wiki.js uses BCP-47-ish codes: `en`, `de`, `pt-br`, `zh-cn`. The locale is
 * part of a page's identity, not a display preference — the same path in two
 * locales is two different pages.
 */
export const localeParam = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z]{2,3}(-[a-z]{2,4})?$/,
    'a locale is a code like "en", "de" or "pt-br"'
  )
  .describe(
    'Locale code. Defaults to WIKIJS_LOCALE. The locale is part of a page’s identity.'
  );

/** Confirmation token returned by the first call of a guarded tool. */
export const confirmTokenParam = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{32}$/,
    'a confirmation token is 32 hexadecimal characters, as returned by the previous call'
  )
  .describe(
    'Token from this tool’s previous, unconfirmed call. Omit it to receive one.'
  );

/** Default number of entries a list tool returns when the caller says nothing. */
export const DEFAULT_LIMIT = 50;

export const limitParam = z
  .number()
  .int()
  .min(1)
  .max(500)
  .describe(
    `Maximum number of entries to return (default ${DEFAULT_LIMIT}). Wiki.js has ` +
      'no offset for page lists, so narrowing by tags, locale or path beats raising this.'
  );

/**
 * A page tag.
 *
 * Wiki.js lowercases tags on write and stores them without spaces; a tag with a
 * space in it becomes two tags and neither is the one that was meant.
 */
export const tagParam = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(255)
  .regex(
    /^[^\s,]+$/,
    'a tag may not contain spaces or commas — Wiki.js would split it into several tags'
  )
  .describe('A single page tag, lowercase and without spaces.');

/** Free-form page title. */
export const titleParam = z
  .string()
  .trim()
  .min(1, 'a page needs a title')
  .max(255)
  .describe('Page title as shown in the wiki.');

export const descriptionParam = z
  .string()
  .trim()
  .max(255)
  .describe('Short page description, shown in listings and search results.');

/**
 * Page body.
 *
 * Wiki.js refuses an empty page with `PageEmptyContent`, so that is caught here
 * rather than in a round trip.
 */
export const contentParam = z
  .string()
  .min(1, 'Wiki.js refuses a page with empty content')
  .max(
    5_000_000,
    'a page body above 5 MB is almost certainly a mistake; Wiki.js will struggle with it too'
  )
  .describe('Full page body, in the page’s content format.');

/**
 * The editor a page is stored with.
 *
 * Not cosmetic: it decides how `content` is interpreted. Creating a page with
 * `editor: "markdown"` and HTML content stores the HTML as literal markdown.
 */
export const editorParam = z
  .enum(['markdown', 'ckeditor', 'code', 'asciidoc'])
  .describe(
    'Storage format. "markdown" for markdown source, "ckeditor" for rich-text ' +
      'HTML, "code" for raw HTML, "asciidoc" for AsciiDoc.'
  );

/** One find-and-replace edit. */
export const editParam = z
  .object({
    old_text: z
      .string()
      .min(1)
      .describe(
        'Exact text to replace. Must appear exactly once in the page — include ' +
          'surrounding lines until it is unique.'
      ),
    new_text: z.string().describe('Replacement text. May be empty to delete.'),
  })
  .describe('A single surgical edit.');

/**
 * An http(s) URL supplied by a caller.
 *
 * Hand-rolled rather than `z.string().url()`, which accepts `javascript:`,
 * `file:` and `data:` — a scheme check that lives in the schema is the only one
 * that cannot be forgotten at a call site.
 */
export const httpUrlParam = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    },
    { message: 'must be an absolute http:// or https:// URL' }
  )
  .describe('Absolute http:// or https:// URL.');

/** Email address, for the user tools. */
export const emailParam = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(255)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must look like an email address')
  .describe('Email address, which is also the login for local accounts.');

/**
 * A regular expression supplied by a caller.
 *
 * Compiled here so an invalid pattern is a schema error naming the problem,
 * rather than a runtime throw halfway through fetching fifty pages.
 */
export const patternParam = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) => {
      try {
        new RegExp(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'not a valid JavaScript regular expression' }
  )
  .describe('JavaScript regular expression, matched against page content.');
