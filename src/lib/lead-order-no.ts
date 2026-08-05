/**
 * Order numbers on manually-added call-list rows run as a padded serial —
 * "#0001", "#0002" — so a phone order can be referred to by number the same
 * way a website order can.
 *
 * The width is read back out of the numbers already in use rather than fixed
 * here, so a shop that started at "#001" keeps three digits and one that
 * started at "#0001" keeps four. Website orders carry WooCommerce's own
 * numbering (#1284) and are deliberately left out of this count — mixing the
 * two would make the manual serial jump to wherever the store happens to be.
 *
 * Only the suggestion lives here. The field itself stays free text: an order
 * written on a paper pad sometimes already has its own number, and that one
 * wins.
 */

/** "#0007", "0007" and "7" all read as 7. Anything else isn't in the series. */
const SERIAL_RE = /^#?\s*(\d{1,9})$/;

export function parseOrderNo(value: string | null | undefined): number | null {
  const m = SERIAL_RE.exec((value ?? "").trim());
  return m ? Number(m[1]) : null;
}

export function formatOrderNo(n: number, width = 4): string {
  return `#${String(n).padStart(width, "0")}`;
}

/** Digits actually typed, so "#001" and "#0001" don't both become four wide. */
function serialWidth(value: string): number {
  return SERIAL_RE.exec(value.trim())?.[1].length ?? 0;
}

/**
 * Next free number: highest in use + 1, so a deleted row's number is never
 * handed out twice. An empty list starts the series at "#0001".
 */
export function nextOrderNo(existing: (string | null | undefined)[]): string {
  let max = 0;
  let width = 0;
  for (const value of existing) {
    const n = parseOrderNo(value);
    if (n === null) continue;
    if (n > max) max = n;
    width = Math.max(width, serialWidth(value!));
  }
  return formatOrderNo(max + 1, width || 4);
}
