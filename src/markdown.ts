/**
 * Outlining and windowing for page content.
 *
 * Wiki.js has a `toc` field on `Page` and it is tempting to use it — but on
 * 2.5.314 it comes back as an empty string for every markdown page that has not
 * been re-rendered, so a server that trusted it would report "this page has no
 * headings" for a page full of them. Deriving the outline from the source is
 * both reliable and works before a page has ever been rendered.
 */

export interface Heading {
  /** 1 for `#`, 6 for `######`. */
  level: number;
  title: string;
  /** 1-based line number in the source. */
  line: number;
  /** Character offset of the heading line in the source. */
  offset: number;
}

/**
 * Extracts ATX and setext headings from markdown source.
 *
 * Fenced blocks are skipped: a shell session in a code fence is full of lines
 * starting with `#`, and every one of them would otherwise become a section the
 * page does not have.
 */
export function outlineOf(content: string): Heading[] {
  const lines = content.split('\n');
  const headings: Heading[] = [];
  let offset = 0;
  let fence: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1];
      if (fence === undefined) {
        fence = marker[0];
      } else if (marker[0] === fence) {
        fence = undefined;
      }
      offset += line.length + 1;
      continue;
    }
    if (fence !== undefined) {
      offset += line.length + 1;
      continue;
    }

    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx?.[1] !== undefined && atx[2] !== undefined) {
      headings.push({
        level: atx[1].length,
        title: atx[2].trim(),
        line: i + 1,
        offset,
      });
      offset += line.length + 1;
      continue;
    }

    // Setext: a line of === or --- underneath a non-empty line.
    const next = lines[i + 1];
    if (
      trimmed.length > 0 &&
      next !== undefined &&
      /^(=+|-{2,})\s*$/.test(next.trim()) &&
      !/^\s*[-*+]\s/.test(line)
    ) {
      headings.push({
        level: next.trim().startsWith('=') ? 1 : 2,
        title: trimmed,
        line: i + 1,
        offset,
      });
    }
    offset += line.length + 1;
  }

  return headings;
}

/** Normalises a heading for comparison: case, punctuation and spacing all vary. */
function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface SectionResult {
  heading: string;
  level: number;
  /** The heading line and everything below it, up to the next peer heading. */
  text: string;
  startLine: number;
  endLine: number;
}

/**
 * Returns one section of a page, addressed by its heading.
 *
 * A section runs from its heading to the next heading of the *same or higher*
 * level, so asking for a `##` brings its `###` subsections with it — which is
 * what "the section about X" means to a reader.
 *
 * Matching is forgiving about case and punctuation but refuses an ambiguous
 * request: two headings with the same text is common in a long page ("Setup"
 * under two different products), and silently taking the first one is how a
 * model edits the wrong half of a document.
 */
export function sectionOf(
  content: string,
  wanted: string
): SectionResult | { error: string } {
  const headings = outlineOf(content);
  if (headings.length === 0) {
    return {
      error:
        'This page has no markdown headings, so it cannot be addressed by ' +
        'section. Use offset and max_chars to read it in windows.',
    };
  }

  const target = normaliseTitle(wanted);
  const matches = headings.filter((h) => normaliseTitle(h.title) === target);
  if (matches.length === 0) {
    return {
      error:
        `No heading matches "${wanted}". The page has: ` +
        `${headings.map((h) => `${'#'.repeat(h.level)} ${h.title}`).join(' | ')}`,
    };
  }
  if (matches.length > 1) {
    return {
      error:
        `"${wanted}" matches ${matches.length} headings in this page (lines ` +
        `${matches.map((h) => h.line).join(', ')}). Read the page with ` +
        'mode="outline" and address the section by its exact, distinct heading, ' +
        'or read a window with offset and max_chars.',
    };
  }

  const start = matches[0];
  if (start === undefined) {
    return { error: `No heading matches "${wanted}".` };
  }
  const after = headings.filter(
    (h) => h.line > start.line && h.level <= start.level
  );
  const lines = content.split('\n');
  const endLine = after[0] ? after[0].line - 1 : lines.length;
  return {
    heading: start.title,
    level: start.level,
    text: lines.slice(start.line - 1, endLine).join('\n'),
    startLine: start.line,
    endLine,
  };
}

export interface Window {
  text: string;
  offset: number;
  returnedChars: number;
  totalChars: number;
  truncated: boolean;
  /** Set when there is more to read, and says exactly how to get it. */
  note?: string;
}

/**
 * Slices content for a caller that asked for a window of it.
 *
 * The note is not decoration: a window without one reads exactly like a short
 * page, and the model stops there. Naming the next offset is what makes reading
 * a 200 kB page in pieces something a model actually does.
 */
export function windowOf(
  content: string,
  offset: number,
  maxChars: number
): Window {
  const total = content.length;
  const from = Math.min(Math.max(offset, 0), total);
  const text = content.slice(from, from + maxChars);
  const end = from + text.length;
  const truncated = end < total;
  const window: Window = {
    text,
    offset: from,
    returnedChars: text.length,
    totalChars: total,
    truncated,
  };
  if (truncated) {
    window.note =
      `${total - end} characters remain. Call get_page again with offset=${end} ` +
      'for the next window, or use mode="outline" and then section= to jump ' +
      'straight to the part you need.';
  }
  return window;
}
