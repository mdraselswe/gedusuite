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

/**
 * The substrings a typed search should be matched against a stored phone with.
 *
 * A number does not sit in the database in one single shape: a customer's is
 * stored normalized, while the delivery phone on an order is kept exactly as
 * the parcel was addressed. So the query is what has to vary — searching for
 * "+880 1712-345678" must still reach a row holding "01712345678", and a
 * partial "345678" has to keep working as a plain substring.
 *
 * Empty when the query holds no digits: a search for a name must not also drag
 * in whatever numbers happen to contain those letters.
 */
export function phoneSearchTerms(raw?: string | null): string[] {
  const typed = (raw ?? "").trim();
  const digits = typed.replace(/\D/g, "");
  if (!digits) return [];
  const terms = [digits];
  // The query as typed, but only when it reads as a number rather than a name:
  // a delivery phone is stored as written, so "01712 345678" may be in the
  // column with its separators intact.
  if (typed !== digits && /^[\d\s+()./-]+$/.test(typed)) terms.push(typed);
  const normalized = normalizePhone(digits);
  if (normalized) terms.push(normalized);
  return [...new Set(terms)];
}
