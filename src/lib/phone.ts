/**
 * Phone numbers as a matching key.
 *
 * A number is how a customer is actually identified here — courier, bKash and
 * delivery all key on it — so the same person must not end up as two customer
 * rows just because one order was typed "+8801712345678" and the next
 * "01712 345678". Splitting them silently splits their order history and their
 * outstanding balance, and hides the one thing worth knowing before a COD
 * delivery: how often this number has cancelled before.
 *
 * Matching only. There is deliberately no unique constraint in the database:
 * a shared family or shop number is a real thing, just a rare one, and a hard
 * constraint would push people into typing a stray space to get past it —
 * which makes the data worse, not better.
 */

/**
 * Reduce a number to the form used for comparison: 01XXXXXXXXX.
 *
 * Conservative on anything that isn't recognisably a Bangladeshi mobile —
 * unknown shapes keep their digits rather than being reshaped into something
 * that looks valid but isn't.
 */
export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (!d) return null;

  // +8801712345678 / 8801712345678 -> 01712345678
  if (d.length === 13 && d.startsWith("880")) d = d.slice(2);
  // 8801712345678 without the leading zero, i.e. 88 + 1XXXXXXXXX
  else if (d.length === 12 && d.startsWith("88")) d = `0${d.slice(2)}`;
  // 1712345678 — the leading zero dropped, which forms do constantly
  else if (d.length === 10 && d.startsWith("1")) d = `0${d}`;

  return d;
}

/** True when both reduce to the same number; blank never matches blank. */
export function samePhone(a?: string | null, b?: string | null) {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  return Boolean(x && y && x === y);
}
