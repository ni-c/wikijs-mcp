import type {
  McpServer,
  CallToolResult,
  InputRequiredResult,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  budgetedList,
  budgetedUntrustedResult,
  jsonResult,
  run,
  textResult,
} from '../result.js';
import {
  confirmTokenParam,
  contentParam,
  DEFAULT_LIMIT,
  descriptionParam,
  editParam,
  editorParam,
  idParam,
  limitParam,
  localeParam,
  pagePathParam,
  patternParam,
  tagParam,
  titleParam,
} from '../schema.js';

import { assertSucceeded, WikiJsGraphQLError, type WikiJsApi } from '../api.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
} from './annotations.js';
import { identifier } from '../resource-key.js';
import { applyEdits } from '../edits.js';
import * as adminGql from '../gql/admin.js';
import * as gql from '../gql/pages.js';
import { matchPages } from '../grep.js';
import { guarded } from '../guard.js';
import { outlineOf, sectionOf, windowOf } from '../markdown.js';
import { listOf, objectOf } from '../normalize.js';
import { assertWithinScope } from '../paths.js';
import type { ToolContext } from './context.js';

/** Bounds `grep_pages`, which is the one tool that fetches many pages at once. */
const GREP_MAX_PAGES = 200;
const GREP_DEFAULT_PAGES = 60;
const GREP_MAX_MATCHES = 200;
const GREP_MAX_MATCHES_PER_PAGE = 20;
/**
 * Ceiling on the page text held in memory for one search.
 *
 * A page body may be 5 MB, so sixty of them is three hundred — and all of it is
 * copied into the match worker.
 */
const GREP_MAX_BYTES = 8 * 1024 * 1024;
/**
 * One deadline for the whole fetch loop.
 *
 * Each request already has its own 30-second timeout, which bounds a request and
 * not a tool call: two hundred of them in sequence is an hour and a half.
 */
const GREP_FETCH_DEADLINE_MS = 60_000;

/** Default window when a caller asks for content without saying how much. */
const DEFAULT_MAX_CHARS = 20_000;

/**
 * Resolves a page id from either an id or a path.
 *
 * Every page tool accepts both, because a model that just read a search result
 * has a path and a model that just listed pages has an id, and making either
 * one look up the other first is a wasted round trip and a wasted turn.
 */
async function resolvePage(
  api: WikiJsApi,
  args: {
    page_id?: number | undefined;
    path?: string | undefined;
    locale?: string | undefined;
  }
): Promise<Record<string, unknown>> {
  if (args.page_id !== undefined) {
    const data = await api.execute('get_page', gql.GET_PAGE_METADATA, {
      id: args.page_id,
    });
    const pages = objectOf(data.pages, 'the page query');
    return objectOf(pages.single, `page ${args.page_id}`);
  }
  if (args.path === undefined) {
    throw new Error('either page_id or path is required.');
  }
  const locale = args.locale ?? api.defaultLocale;
  const data = await api.execute('get_page', gql.GET_PAGE_METADATA_BY_PATH, {
    path: args.path,
    locale,
  });
  const pages = objectOf(data.pages, 'the page query');
  return objectOf(
    pages.singleByPath,
    `page "${args.path}" in locale "${locale}"`
  );
}

/**
 * Fetches a page's source, degrading to a note when the key may not read it.
 *
 * `Page.content` is gated behind the `read:source` scope. Because a field-level
 * refusal fails the entire GraphQL query, asking for content and metadata
 * together means a key without that scope cannot fetch a page's *title*. Two
 * queries and this catch are what make the read-only-metadata case work instead
 * of looking like the page does not exist.
 */
async function fetchContent(
  api: WikiJsApi,
  id: number
): Promise<{ content: string } | { unavailable: string }> {
  try {
    const data = await api.execute('get_page', gql.GET_PAGE_CONTENT, { id });
    const pages = objectOf(data.pages, 'the page query');
    const page = objectOf(pages.single, `page ${id}`);
    return { content: typeof page.content === 'string' ? page.content : '' };
  } catch (error) {
    if (error instanceof WikiJsGraphQLError && error.isForbidden) {
      return {
        unavailable:
          'The API key may list this page but not read its source: that needs ' +
          'the read:source scope, which is separate from read:pages. Metadata ' +
          'is shown above; mode="rendered" may still work.',
      };
    }
    throw error;
  }
}

/** The tags array shape differs between `list` (strings) and `single` (objects). */
function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : ((entry as { tag?: unknown } | null)?.tag ?? '')
    )
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

export function registerPageTools(
  server: McpServer,
  { api, approval, confirmations, scope, reads, readOnly }: ToolContext
): void {
  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description:
        'Lists pages with their metadata, newest first by default. The result ' +
        'reports how many pages matched as well as how many are shown, so a ' +
        'short answer is never mistaken for a small wiki. Wiki.js has no offset ' +
        'for this query, so narrow with tags, locale, creator_id or author_id ' +
        'rather than paging. Returns no page content; use get_page for that.',
      inputSchema: z.object({
        limit: limitParam.optional(),
        tags: z
          .array(tagParam)
          .max(20)
          .optional()
          .describe('Only pages carrying all of these tags.'),
        locale: localeParam.optional(),
        creator_id: idParam
          .optional()
          .describe('Only pages originally created by this user id.'),
        author_id: idParam
          .optional()
          .describe('Only pages last edited by this user id.'),
        order_by: z
          .enum(['TITLE', 'CREATED', 'UPDATED', 'PATH', 'ID'])
          .optional()
          .describe('Sort field (default UPDATED).'),
        direction: z.enum(['ASC', 'DESC']).optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({
      limit,
      tags,
      locale,
      creator_id,
      author_id,
      order_by,
      direction,
    }) =>
      run(async () => {
        const max = limit ?? DEFAULT_LIMIT;
        const data = await api.execute('list_pages', gql.LIST_PAGES, {
          orderBy: order_by ?? 'UPDATED',
          orderByDirection: direction ?? 'DESC',
          tags: tags ?? null,
          locale: locale ?? null,
          creatorId: creator_id ?? null,
          authorId: author_id ?? null,
        });
        const pages = objectOf(data.pages, 'the page query');
        // Sliced here, not by Wiki.js — see the comment on LIST_PAGES. Passing
        // its `limit` would silently return a fraction of the matching pages
        // and give no hint that it had.
        const all = listOf(pages.list, 'pages');
        const list = all.slice(0, max);
        return budgetedList('pages', list, {
          untrusted: true,
          narrowWith:
            'Narrow with tags, locale, creator_id or author_id — Wiki.js offers ' +
            'no offset for this query.',
          extra: {
            shown: list.length,
            matching: all.length,
            limit: max,
            ...(all.length > list.length
              ? {
                  note:
                    `${all.length - list.length} further pages match; raise limit ` +
                    'or narrow with tags, locale, creator_id or author_id.',
                }
              : {}),
          },
        });
      })
  );

  server.registerTool(
    'get_page',
    {
      title: 'Get a page',
      description:
        'Reads one page, addressed by page_id or by path plus locale. Choose a ' +
        'mode: "metadata" for everything but the text, "outline" for the ' +
        'headings only (cheapest way to see what a long page contains), ' +
        '"content" for the source, "rendered" for the HTML. With mode=content, ' +
        'either pass section to get one heading’s worth, or offset and ' +
        'max_chars to read the page in windows — a large page will otherwise be ' +
        'truncated to fit the result budget.',
      inputSchema: z.object({
        page_id: idParam.optional(),
        path: pagePathParam.optional(),
        locale: localeParam.optional(),
        mode: z
          .enum(['metadata', 'outline', 'content', 'rendered'])
          .optional()
          .describe('What to return (default "content").'),
        section: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .optional()
          .describe(
            'With mode=content: return only the section under this heading, ' +
              'including its subsections. Refuses an ambiguous heading rather ' +
              'than guessing.'
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('With mode=content: character offset to start at.'),
        max_chars: z
          .number()
          .int()
          .min(100)
          .max(200_000)
          .optional()
          .describe(
            `With mode=content: how much to return (default ${DEFAULT_MAX_CHARS}).`
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({
      page_id,
      path,
      locale,
      mode,
      section,
      offset,
      max_chars,
    }): Promise<CallToolResult | InputRequiredResult> =>
      run(async () => {
        const page = await resolvePage(api, { page_id, path, locale });
        const id = page.id as number;
        const wanted = mode ?? 'content';
        const meta = { ...page, tags: tagNames(page.tags) };
        // Remember when the caller saw this page. update_page compares against
        // this, not against its own read — see src/read-log.ts.
        reads.record(id, String(page.updatedAt));

        if (wanted === 'metadata') {
          return budgetedUntrustedResult({ page: meta });
        }

        if (wanted === 'rendered') {
          const data = await api.execute('get_page', gql.GET_PAGE_RENDER, {
            id,
          });
          const pages = objectOf(data.pages, 'the page query');
          const rendered = objectOf(pages.single, `page ${id}`);
          return budgetedUntrustedResult({
            page: meta,
            render: rendered.render,
          });
        }

        const source = await fetchContent(api, id);
        if ('unavailable' in source) {
          return budgetedUntrustedResult({
            page: meta,
            content_unavailable: source.unavailable,
          });
        }

        if (wanted === 'outline') {
          const headings = outlineOf(source.content);
          return budgetedUntrustedResult({
            page: meta,
            totalChars: source.content.length,
            outline: headings.map((h) => ({
              level: h.level,
              title: h.title,
              line: h.line,
            })),
            note:
              headings.length === 0
                ? 'This page has no markdown headings. Read it with offset and max_chars.'
                : 'Fetch one part with mode="content" and section="<heading>".',
          });
        }

        if (section !== undefined) {
          const found = sectionOf(source.content, section);
          if ('error' in found) {
            return budgetedUntrustedResult({ page: meta, error: found.error });
          }
          return budgetedUntrustedResult({ page: meta, section: found });
        }

        const window = windowOf(
          source.content,
          offset ?? 0,
          max_chars ?? DEFAULT_MAX_CHARS
        );
        return budgetedUntrustedResult({ page: meta, content: window });
      })
  );

  server.registerTool(
    'search_pages',
    {
      title: 'Search pages',
      description:
        'Full-text search — but read this first: on a default Wiki.js the ' +
        'search engine is "Database - Basic", which only indexes page titles ' +
        'and descriptions, NOT the text inside pages. The result names the ' +
        'active engine so you can tell. If the engine is basic and you are ' +
        'looking for something written inside a page, use grep_pages instead. ' +
        'Results carry no excerpt; follow up with get_page.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(500).describe('Search terms.'),
        path: z
          .string()
          .trim()
          .max(2048)
          .optional()
          .describe('Restrict to this path prefix.'),
        locale: localeParam.optional(),
        limit: limitParam.optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, path, locale, limit }) =>
      run(async () => {
        const data = await api.execute('search_pages', gql.SEARCH_PAGES, {
          query,
          path: path ?? null,
          locale: locale ?? null,
        });
        const pages = objectOf(data.pages, 'the page query');
        const found = objectOf(pages.search, 'the search result');
        const results = listOf(found.results, 'search results');
        const max = limit ?? DEFAULT_LIMIT;

        // The engine is looked up per search rather than cached: it is one small
        // query, and a wrong-but-cached answer here would mislead every later
        // search in the session.
        let engine = 'unknown';
        let engineNote: string;
        try {
          const engines = objectOf(
            (await api.execute('search_pages', adminGql.LIST_SEARCH_ENGINES))
              .search,
            'the search engine list'
          );
          const active = listOf(engines.searchEngines, 'search engines').find(
            (e) => (e as { isEnabled?: boolean }).isEnabled === true
          ) as { key?: string; title?: string } | undefined;
          engine = active?.key ?? 'none';
          engineNote =
            engine === 'db'
              ? 'The active engine is "Database - Basic", which indexes only ' +
                'titles and descriptions. Text inside pages is NOT searched — ' +
                'use grep_pages for that.'
              : `The active engine is "${active?.title ?? engine}", which ` +
                'indexes page content.';
        } catch {
          engineNote =
            'The active search engine could not be determined (the API key may ' +
            'lack manage:system). If results seem to ignore page text, the ' +
            'engine is probably "Database - Basic" — use grep_pages.';
        }

        return budgetedList('results', results.slice(0, max), {
          untrusted: true,
          extra: {
            totalHits: found.totalHits,
            suggestions: found.suggestions,
            shown: Math.min(results.length, max),
            searchEngine: engine,
            note: engineNote,
          },
        });
      })
  );

  server.registerTool(
    'grep_pages',
    {
      title: 'Search inside page text',
      description:
        'Searches the actual text of pages with a regular expression, by ' +
        'fetching them and matching locally. This exists because Wiki.js’ ' +
        'default search engine does not index page content at all. It is the ' +
        'expensive path — one request per page — so narrow it with path_prefix, ' +
        'tags or locale, and keep max_pages small. Returns matching lines with ' +
        'context, not whole pages.',
      inputSchema: z.object({
        pattern: patternParam,
        ignore_case: z
          .boolean()
          .optional()
          .describe('Case-insensitive matching (default true).'),
        path_prefix: z
          .string()
          .trim()
          .max(2048)
          .optional()
          .describe('Only pages whose path starts with this prefix.'),
        tags: z.array(tagParam).max(20).optional(),
        locale: localeParam.optional(),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(GREP_MAX_PAGES)
          .optional()
          .describe(
            `How many pages to fetch at most (default ${GREP_DEFAULT_PAGES}).`
          ),
        context_lines: z
          .number()
          .int()
          .min(0)
          .max(10)
          .optional()
          .describe('Lines of context around each match (default 1).'),
      }),
      annotations: READ_ONLY,
    },
    async ({
      pattern,
      ignore_case,
      path_prefix,
      tags,
      locale,
      max_pages,
      context_lines,
    }) =>
      run(async () => {
        const budget = max_pages ?? GREP_DEFAULT_PAGES;
        const context = context_lines ?? 1;

        const data = await api.execute('grep_pages', gql.LIST_PAGES, {
          orderBy: 'UPDATED',
          orderByDirection: 'DESC',
          tags: tags ?? null,
          locale: locale ?? null,
          creatorId: null,
          authorId: null,
        });
        const pages = objectOf(data.pages, 'the page query');
        const everything = listOf(pages.list, 'pages') as Array<{
          id: number;
          path: string;
          title?: string;
          locale?: string;
        }>;
        // Wiki.js' own `limit` counts joined tag rows, not pages, so the ceiling
        // is applied here — otherwise this would scan a fraction of what it
        // reports and quietly miss matches.
        const all = everything.slice(0, GREP_MAX_PAGES);
        const candidates = all.filter((p) =>
          path_prefix === undefined ? true : p.path.startsWith(path_prefix)
        );
        const wanted = candidates.slice(0, budget);

        // One deadline for the whole fetch loop. Each request has its own
        // 30-second timeout, so without this a slow upstream turns a single tool
        // call into an hour and a half during which the server answers nothing.
        const deadline = Date.now() + GREP_FETCH_DEADLINE_MS;
        const fetched: Array<{
          id: number;
          path: string;
          title?: string;
          locale?: string;
          content: string;
        }> = [];
        let unreadable = 0;
        let bytes = 0;
        let stoppedByBytes = false;
        let stoppedByTime = false;

        for (const candidate of wanted) {
          if (Date.now() > deadline) {
            stoppedByTime = true;
            break;
          }
          if (bytes >= GREP_MAX_BYTES) {
            stoppedByBytes = true;
            break;
          }
          const source = await fetchContent(api, candidate.id);
          if ('unavailable' in source) {
            unreadable++;
            continue;
          }
          bytes += Buffer.byteLength(source.content, 'utf8');
          fetched.push({ ...candidate, content: source.content });
        }

        // The match itself runs in a worker that can be killed — see src/grep.ts.
        const result = await matchPages({
          pattern,
          ignoreCase: ignore_case !== false,
          contextLines: context,
          maxMatchesPerPage: GREP_MAX_MATCHES_PER_PAGE,
          maxMatches: GREP_MAX_MATCHES,
          pages: fetched,
        });

        const notes: string[] = [];
        if (candidates.length > wanted.length) {
          notes.push(
            `${candidates.length - wanted.length} further pages matched the ` +
              'filters but were not fetched. Raise max_pages, or narrow with ' +
              'path_prefix, tags or locale.'
          );
        }
        if (everything.length > all.length) {
          notes.push(
            `This wiki has ${everything.length} pages; only the ` +
              `${GREP_MAX_PAGES} most recently updated were considered.`
          );
        }
        if (stoppedByTime) {
          notes.push(
            `Stopped fetching after ${GREP_FETCH_DEADLINE_MS / 1000} seconds ` +
              `with ${fetched.length} page(s) read. Narrow the search.`
          );
        }
        if (stoppedByBytes) {
          notes.push(
            `Stopped fetching at ${Math.round(GREP_MAX_BYTES / 1024)} KB of page ` +
              `text with ${fetched.length} page(s) read. Narrow the search.`
          );
        }
        if (unreadable > 0) {
          notes.push(
            `${unreadable} page(s) could not be read: the API key lacks the ` +
              'read:source scope for them.'
          );
        }
        if (result.stoppedAtLimit) {
          notes.push(
            `Stopped at ${GREP_MAX_MATCHES} matches. Make the pattern more specific.`
          );
        }

        return budgetedList('pages', result.hits, {
          untrusted: true,
          extra: {
            pagesScanned: fetched.length,
            pagesMatched: result.hits.length,
            matches: result.matchCount,
            ...(notes.length > 0 ? { notes } : {}),
          },
        });
      })
  );

  server.registerTool(
    'get_page_tree',
    {
      title: 'Browse the page tree',
      description:
        'Lists the pages and folders directly under a path — the structural ' +
        'view a wiki has and a search does not. mode "ALL" returns both folders ' +
        'and pages, "FOLDERS" only folders, "PAGES" only pages. Wiki.js offers ' +
        'no limit on this query, so a very wide level is truncated to the ' +
        'result budget.',
      inputSchema: z.object({
        path: z
          .string()
          .trim()
          .max(2048)
          .optional()
          .describe('Parent path. Omit for the root of the wiki.'),
        locale: localeParam.optional(),
        mode: z.enum(['ALL', 'FOLDERS', 'PAGES']).optional(),
        include_ancestors: z
          .boolean()
          .optional()
          .describe('Also return the path from the root down to this level.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ path, locale, mode, include_ancestors }) =>
      run(async () => {
        const data = await api.execute('get_page_tree', gql.PAGE_TREE, {
          path: path ?? '',
          parent: null,
          mode: mode ?? 'ALL',
          locale: locale ?? api.defaultLocale,
          includeAncestors: include_ancestors ?? false,
        });
        const pages = objectOf(data.pages, 'the page query');
        const tree = listOf(pages.tree, 'the page tree');
        return budgetedList('items', tree, {
          untrusted: true,
          narrowWith: 'Descend one level at a time by passing a deeper path.',
          extra: { count: tree.length },
        });
      })
  );

  server.registerTool(
    'list_page_links',
    {
      title: 'List internal links',
      description:
        'Returns every page together with the internal links it contains — the ' +
        'wiki’s link graph for one locale. Useful for finding what would break ' +
        'before moving or deleting a page. Wiki.js returns the whole graph at ' +
        'once and offers no filter, so on a large wiki this is truncated.',
      inputSchema: z.object({ locale: localeParam.optional() }),
      annotations: READ_ONLY,
    },
    async ({ locale }) =>
      run(async () => {
        const data = await api.execute('list_page_links', gql.PAGE_LINKS, {
          locale: locale ?? api.defaultLocale,
        });
        const pages = objectOf(data.pages, 'the page query');
        const links = listOf(pages.links, 'the link graph');
        return budgetedList('pages', links, {
          untrusted: true,
          extra: { count: links.length },
        });
      })
  );

  if (readOnly) return;

  server.registerTool(
    'create_page',
    {
      title: 'Create a page',
      description:
        'Creates a page. The path must not already exist in this locale — ' +
        'Wiki.js answers PageDuplicateCreate otherwise, and update_page is what ' +
        'changes an existing one. The editor decides how content is ' +
        'interpreted, so markdown source needs editor="markdown".',
      inputSchema: z.object({
        path: pagePathParam,
        title: titleParam,
        content: contentParam,
        description: descriptionParam.optional(),
        locale: localeParam.optional(),
        tags: z.array(tagParam).max(50).optional(),
        editor: editorParam.optional(),
        is_published: z
          .boolean()
          .optional()
          .describe(
            'Publish immediately (default true). False creates a draft.'
          ),
        is_private: z.boolean().optional(),
      }),
      annotations: WRITE,
    },
    async ({
      path,
      title,
      content,
      description,
      locale,
      tags,
      editor,
      is_published,
      is_private,
    }) =>
      run(async () => {
        assertWithinScope(scope, path, 'page path');
        const data = await api.execute('create_page', gql.CREATE_PAGE, {
          path,
          title,
          content,
          description: description ?? '',
          locale: locale ?? api.defaultLocale,
          tags: tags ?? [],
          editor: editor ?? 'markdown',
          isPublished: is_published ?? true,
          isPrivate: is_private ?? false,
        });
        const pages = objectOf(data.pages, 'the page mutation');
        assertSucceeded(pages.create, 'create_page');
        return jsonResult({
          created: (pages.create as { page?: unknown }).page,
        });
      })
  );

  server.registerTool(
    'update_page',
    {
      title: 'Update a page',
      description:
        'Changes a page. Pass content to replace the whole body, or edits for ' +
        'surgical find-and-replace — each edit’s old_text must appear exactly ' +
        'once, and an ambiguous or missing match is refused rather than applied ' +
        'to the wrong place. Before writing, this checks whether somebody else ' +
        'changed the page since it was read and refuses to clobber them; pass ' +
        'force=true to overwrite deliberately. Metadata fields can be changed ' +
        'on their own, without touching the text.',
      inputSchema: z.object({
        page_id: idParam.optional(),
        path: pagePathParam.optional(),
        locale: localeParam.optional(),
        content: contentParam
          .optional()
          .describe('Replacement body. Mutually exclusive with edits.'),
        edits: z
          .array(editParam)
          .min(1)
          .max(50)
          .optional()
          .describe('Find-and-replace edits. Mutually exclusive with content.'),
        title: titleParam.optional(),
        description: descriptionParam.optional(),
        tags: z
          .array(tagParam)
          .max(50)
          .optional()
          .describe('Replaces the whole tag list, it is not merged.'),
        is_published: z.boolean().optional(),
        is_private: z.boolean().optional(),
        editor: editorParam.optional(),
        expected_updated_at: z
          .string()
          .trim()
          .max(64)
          .optional()
          .describe(
            'The updatedAt value you saw when you read this page. Normally ' +
              'unnecessary — a previous get_page in this session is remembered ' +
              'automatically — but it makes the concurrent-edit check work ' +
              'without one.'
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            'Write even though the page changed since you read it. Overwrites ' +
              'the other person’s edit.'
          ),
      }),
      annotations: WRITE,
    },
    async ({
      page_id,
      path,
      locale,
      content,
      edits,
      title,
      description,
      tags,
      is_published,
      is_private,
      editor,
      expected_updated_at,
      force,
    }) =>
      run(async () => {
        if (content !== undefined && edits !== undefined) {
          throw new Error(
            'pass either content or edits, not both — they are two ways of ' +
              'saying what the new body is.'
          );
        }

        const page = await resolvePage(api, { page_id, path, locale });
        const id = page.id as number;
        const currentPath = String(page.path);
        assertWithinScope(scope, currentPath, 'page path');

        // The checkout date is when the *caller* last read this page, not when
        // this handler just read it: comparing the page against a timestamp
        // fetched milliseconds ago can never fail, which is protection in
        // appearance only. Without a prior read there is nothing to compare, so
        // the guard says so instead of pretending.
        const checkoutDate =
          expected_updated_at ?? reads.checkoutDate(id) ?? undefined;

        if (force !== true && checkoutDate !== undefined) {
          const conflict = await api.execute(
            'update_page',
            gql.CHECK_CONFLICTS,
            { id, checkoutDate }
          );
          const pagesQuery = objectOf(conflict.pages, 'the conflict check');
          if (pagesQuery.checkConflicts === true) {
            // Drop the stale read, so a second attempt without re-reading does
            // not compare against the same superseded timestamp again.
            reads.forget(id);
            return textResult(
              `Refusing to write: page ${id} changed after you read it ` +
                `(you saw ${checkoutDate}, it is now ${String(page.updatedAt)}). ` +
                'Somebody else saved it in the meantime and this write would ' +
                'silently discard their edit. Call get_page_conflict to see the ' +
                'newer version, re-read the page with get_page and redo the ' +
                'change on top of it — or call update_page again with ' +
                'force=true to overwrite their edit on purpose.'
            );
          }
        }

        // The body always has to be sent. Wiki.js reads a null `content` as an
        // empty page and refuses the write with PageEmptyContent, so there is no
        // way to change only a title or a tag without resending the text — which
        // means even a metadata-only edit needs the read:source scope.
        let newContent: string | undefined = content;
        if (newContent === undefined) {
          const source = await fetchContent(api, id);
          if ('unavailable' in source) {
            throw new Error(
              edits === undefined
                ? 'changing a page needs its current body, because Wiki.js ' +
                    'treats an omitted body as an empty page — and this API key ' +
                    'may not read page source (scope read:source). Pass content ' +
                    'explicitly to replace the page wholesale.'
                : 'edits need the current page source, which this API key may ' +
                    'not read (scope read:source). Pass content to replace the ' +
                    'page wholesale instead.'
            );
          }
          newContent =
            edits === undefined
              ? source.content
              : applyEdits(source.content, edits);
        }

        // Every field is sent, with the caller's value where they gave one and
        // the page's current value everywhere else. Wiki.js' update mutation
        // treats an unsupplied argument differently for every field and none of
        // the three ways means "leave it alone": omitting `isPublished`
        // *unpublishes* the page, passing null for `title` or `description` is
        // rejected with `ValidationError: should be string`, and a null
        // `content` is read as an empty page and refused with PageEmptyContent.
        // Merging over the values just read is the only variant with
        // predictable semantics — and it is what Wiki.js' own editor does.
        const data = await api.execute('update_page', gql.UPDATE_PAGE, {
          id,
          content: newContent,
          description: description ?? String(page.description ?? ''),
          editor: editor ?? String(page.editor ?? 'markdown'),
          isPublished: is_published ?? page.isPublished === true,
          isPrivate: is_private ?? page.isPrivate === true,
          tags: tags ?? tagNames(page.tags),
          title: title ?? String(page.title ?? ''),
        });
        const pages = objectOf(data.pages, 'the page mutation');
        assertSucceeded(pages.update, 'update_page');
        // Our own write is now the newest state, so record it: a follow-up edit
        // in the same session must not be refused as somebody else's change.
        const written = pages.update as { page?: { updatedAt?: unknown } };
        if (typeof written.page?.updatedAt === 'string') {
          reads.record(id, written.page.updatedAt);
        } else {
          reads.forget(id);
        }
        return jsonResult({
          updated: (pages.update as { page?: unknown }).page,
          appliedEdits: edits?.length ?? 0,
        });
      })
  );

  server.registerTool(
    'move_page',
    {
      title: 'Move or rename a page',
      description:
        'Moves a page to another path, another locale, or both. Internal links ' +
        'pointing at the old path are NOT rewritten by Wiki.js — check ' +
        'list_page_links first if that matters.',
      inputSchema: z.object({
        page_id: idParam.optional(),
        path: pagePathParam.optional(),
        locale: localeParam.optional(),
        destination_path: pagePathParam,
        destination_locale: localeParam.optional(),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    async (
      {
        page_id,
        path,
        locale,
        destination_path,
        destination_locale,
        confirm_token,
      },
      mcp
    ) =>
      run(async () => {
        const page = await resolvePage(api, { page_id, path, locale });
        const id = page.id as number;
        const from = String(page.path);
        const toLocale = destination_locale ?? api.defaultLocale;
        // Both ends: a scope that only checked the source would let a page be
        // moved out of the allowed area, and one that only checked the target
        // would let a page be moved out of a protected one.
        assertWithinScope(scope, from, 'source page path');
        assertWithinScope(scope, destination_path, 'destination page path');

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'move_page',
            targets: [
              `page:${id}`,
              `to:${destination_path}`,
              `locale:${toLocale}`,
            ],
            what: `move page ${id} from ${identifier(from, 'page path')} to ${identifier(destination_path, 'page path')} (${identifier(toLocale, 'locale')})`,
            consequence:
              'Links elsewhere in the wiki that point at the old path will break.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('move_page', gql.MOVE_PAGE, {
              id,
              destinationPath: destination_path,
              destinationLocale: toLocale,
            });
            const pages = objectOf(data.pages, 'the page mutation');
            assertSucceeded(pages.move, 'move_page');
            return textResult(
              `Moved page ${id} to ${destination_path} (${toLocale}).`
            );
          }
        );
      })
  );

  server.registerTool(
    'delete_page',
    {
      title: 'Delete a page',
      description:
        'Deletes a page and its history. Wiki.js has no trash — this cannot be ' +
        'undone from here. Requires a confirmation token.',
      inputSchema: z.object({
        page_id: idParam.optional(),
        path: pagePathParam.optional(),
        locale: localeParam.optional(),
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ page_id, path, locale, confirm_token }, mcp) =>
      run(async () => {
        const page = await resolvePage(api, { page_id, path, locale });
        const id = page.id as number;
        const pagePath = String(page.path);
        assertWithinScope(scope, pagePath, 'page path');

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'delete_page',
            targets: [String(id)],
            what: `delete page ${id} at ${identifier(pagePath, 'page path')} (${identifier(String(page.locale), 'locale')})`,
            consequence:
              'The page and its version history are removed permanently; Wiki.js has no trash.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute('delete_page', gql.DELETE_PAGE, {
              id,
            });
            const pages = objectOf(data.pages, 'the page mutation');
            assertSucceeded(pages.delete, 'delete_page');
            return textResult(`Deleted page ${id} (${pagePath}).`);
          }
        );
      })
  );

  server.registerTool(
    'convert_page_editor',
    {
      title: 'Convert a page to another editor',
      description:
        'Changes the storage format of a page. Wiki.js does not translate the ' +
        'body — converting markdown to "code" leaves the markdown source as raw ' +
        'HTML text. Use it to correct a page created with the wrong editor, not ' +
        'to reformat one.',
      inputSchema: z.object({
        page_id: idParam.optional(),
        path: pagePathParam.optional(),
        locale: localeParam.optional(),
        editor: editorParam,
        confirm_token: confirmTokenParam.optional(),
      }),
      annotations: WRITE_IDEMPOTENT,
    },
    async ({ page_id, path, locale, editor, confirm_token }, mcp) =>
      run(async () => {
        const page = await resolvePage(api, { page_id, path, locale });
        const id = page.id as number;
        assertWithinScope(scope, String(page.path), 'page path');

        return guarded(
          server,
          mcp,
          approval,
          confirmations,
          {
            tool: 'convert_page_editor',
            targets: [`page:${id}`, `editor:${editor}`],
            what: `convert page ${id} to the ${identifier(editor, 'editor')} editor`,
            consequence:
              'The body is reinterpreted, not translated, so the page may render as literal source afterwards.',
            confirmToken: confirm_token,
          },
          async () => {
            const data = await api.execute(
              'convert_page_editor',
              gql.CONVERT_PAGE,
              { id, editor }
            );
            const pages = objectOf(data.pages, 'the page mutation');
            assertSucceeded(pages.convert, 'convert_page_editor');
            return textResult(`Converted page ${id} to ${editor}.`);
          }
        );
      })
  );
}
