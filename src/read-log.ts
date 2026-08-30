/**
 * Remembers when this server last read each page.
 *
 * This exists because the obvious way to guard against clobbering a concurrent
 * edit does not work. Wiki.js offers `checkConflicts(id, checkoutDate)`, and the
 * tempting implementation is for `update_page` to read the page, take its
 * `updatedAt` and pass that as the checkout date — but then the write is being
 * compared against a timestamp fetched milliseconds earlier, and the check can
 * never fail. It looks like protection and is none. (Verified against a real
 * concurrent edit: the guard passed and the other author's change was lost.)
 *
 * The window that actually matters is the one between the *model* reading a
 * page and deciding what to write — which is however long it spends thinking,
 * and is where a human in the web editor gets in. So the checkout date has to
 * come from that read. `get_page` records it here, `update_page` looks it up.
 *
 * Bounded and in-memory: a stdio server is one session, and forgetting an old
 * entry only costs the guard for a page nobody has looked at recently.
 */
const MAX_ENTRIES = 500;

export class PageReadLog {
  private readonly seen = new Map<number, string>();

  /** Records the `updatedAt` a page had when it was read. */
  record(pageId: number, updatedAt: string): void {
    if (this.seen.size >= MAX_ENTRIES && !this.seen.has(pageId)) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    // Re-insert so the map stays in least-recently-read order.
    this.seen.delete(pageId);
    this.seen.set(pageId, updatedAt);
  }

  /** The timestamp this page carried when it was last read, if it ever was. */
  checkoutDate(pageId: number): string | undefined {
    return this.seen.get(pageId);
  }

  /** Forgets a page, so a write is not compared against a pre-write read. */
  forget(pageId: number): void {
    this.seen.delete(pageId);
  }
}
