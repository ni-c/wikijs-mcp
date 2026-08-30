/**
 * Surgical find-and-replace on page content.
 *
 * The alternative — sending the whole page back on every change — is expensive
 * on a 40 kB page and, worse, it is lossy: a model rewriting a long document
 * from memory drops sections. So this exists, and the contract around it is the
 * part that matters.
 *
 * Every edit must match **exactly once**. The obvious implementation,
 * `content.replace(old, new)`, replaces the first occurrence and reports
 * success, so an `old_text` that appears twice edits whichever one happens to
 * come first — silently, in a document nobody is looking at. That is the
 * failure mode this refuses.
 */

export interface Edit {
  old_text: string;
  new_text: string;
}

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditError';
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

/**
 * Applies edits in order and returns the new content.
 *
 * In order, and each against the result of the previous one: two edits that
 * both matched the original but where the first destroys the second's anchor is
 * a real case, and it has to fail loudly at the second rather than produce a
 * document neither edit describes.
 */
export function applyEdits(content: string, edits: Edit[]): string {
  if (edits.length === 0) {
    throw new EditError('edits was empty — there is nothing to apply.');
  }

  let current = content;
  edits.forEach((edit, index) => {
    const position = `edit ${index + 1} of ${edits.length}`;
    if (edit.old_text.length === 0) {
      throw new EditError(
        `${position}: old_text is empty. To replace the whole page, pass ` +
          'content instead of edits.'
      );
    }
    if (edit.old_text === edit.new_text) {
      throw new EditError(
        `${position}: old_text and new_text are identical, so the edit would ` +
          'change nothing.'
      );
    }

    const matches = countOccurrences(current, edit.old_text);
    if (matches === 0) {
      throw new EditError(
        `${position}: old_text does not appear in the page` +
          (index > 0 ? ' after the preceding edits were applied' : '') +
          '. The page may have changed, or the text may differ in whitespace ' +
          'or line endings. Read the current content with get_page and copy the ' +
          'passage exactly.'
      );
    }
    if (matches > 1) {
      throw new EditError(
        `${position}: old_text appears ${matches} times in the page, so which ` +
          'one to change is ambiguous. Extend old_text with surrounding lines ' +
          'until it is unique.'
      );
    }

    current = current.replace(edit.old_text, () => edit.new_text);
  });

  return current;
}
