/**
 * A line-based unified diff, in about a hundred lines and without a dependency.
 *
 * Wiki.js keeps every version of every page and offers no way to compare two of
 * them — neither the API nor any other MCP server for it. The alternative to
 * this file is pulling two full page bodies into the model's context so it can
 * spot three changed lines itself, which is the expensive way to get a worse
 * answer.
 */

/** Bounds the O(n·m) table below. Above this, fall back to a summary. */
const MAX_DIFF_LINES = 20_000;

export interface DiffResult {
  /** Unified diff text, or a summary when the inputs were too large to diff. */
  diff: string;
  added: number;
  removed: number;
  /** True when the inputs were identical. */
  identical: boolean;
  /** Set when the line-level diff was skipped. */
  note?: string;
}

/**
 * Longest common subsequence over lines, as a table of lengths.
 *
 * The straightforward dynamic program. Page revisions are hundreds of lines,
 * not hundreds of thousands, and the guard above keeps the pathological case
 * out rather than the algorithm being clever.
 */
function lcsLengths(a: string[], b: string[]): Uint32Array[] {
  const table: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i++) table.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = table[i];
    const nextRow = table[i + 1];
    if (row === undefined || nextRow === undefined) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  return table;
}

type Op = { kind: ' ' | '-' | '+'; text: string };

function operations(a: string[], b: string[]): Op[] {
  const table = lcsLengths(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] ?? '' });
      i++;
      j++;
      continue;
    }
    const down = table[i + 1]?.[j] ?? 0;
    const right = table[i]?.[j + 1] ?? 0;
    if (down >= right) {
      ops.push({ kind: '-', text: a[i] ?? '' });
      i++;
    } else {
      ops.push({ kind: '+', text: b[j] ?? '' });
      j++;
    }
  }
  for (; i < a.length; i++) ops.push({ kind: '-', text: a[i] ?? '' });
  for (; j < b.length; j++) ops.push({ kind: '+', text: b[j] ?? '' });
  return ops;
}

/**
 * Renders the operations as unified hunks with `context` lines around changes.
 *
 * Hunks rather than the whole file: on a page where one sentence changed, a
 * full-file diff is the full file again, which defeats the point of asking for
 * a diff at all.
 */
function render(ops: Op[], context: number): string {
  const changed = ops
    .map((op, index) => (op.kind === ' ' ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return '';

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to);
    } else {
      ranges.push([from, to]);
    }
  }

  const out: string[] = [];
  for (const [from, to] of ranges) {
    // Line numbers in each version, counted over the operations before the hunk.
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < from; k++) {
      const kind = ops[k]?.kind;
      if (kind === ' ') {
        oldLine++;
        newLine++;
      } else if (kind === '-') oldLine++;
      else if (kind === '+') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let k = from; k <= to; k++) {
      const kind = ops[k]?.kind;
      if (kind === ' ') {
        oldCount++;
        newCount++;
      } else if (kind === '-') oldCount++;
      else if (kind === '+') newCount++;
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (let k = from; k <= to; k++) {
      const op = ops[k];
      if (op) out.push(`${op.kind}${op.text}`);
    }
  }
  return out.join('\n');
}

/** Compares two page bodies and returns a unified diff. */
export function unifiedDiff(
  before: string,
  after: string,
  context = 3
): DiffResult {
  if (before === after) {
    return { diff: '', added: 0, removed: 0, identical: true };
  }

  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length + b.length > MAX_DIFF_LINES) {
    return {
      diff: '',
      added: 0,
      removed: 0,
      identical: false,
      note:
        `The two versions have ${a.length} and ${b.length} lines, above the ` +
        `${MAX_DIFF_LINES}-line ceiling for a line-by-line comparison. Read the ` +
        'versions with get_page_version instead, or compare a section at a time.',
    };
  }

  const ops = operations(a, b);
  return {
    diff: render(ops, context),
    added: ops.filter((op) => op.kind === '+').length,
    removed: ops.filter((op) => op.kind === '-').length,
    identical: false,
  };
}
