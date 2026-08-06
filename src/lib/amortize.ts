/**
 * Spreading a cost across the months it actually covers.
 *
 * A year of hosting bought in April is not an April expense. Charged in full
 * on the day it was paid, April looks ruinous and May through March look free —
 * and the partner share for each of those months is wrong in one direction or
 * the other. Nothing about the cash changes: that left in April either way and
 * the treasury says so. This is only about which period carries the cost.
 *
 * Spreading is opt-in per purchase. `spreadMonths` null means "charge it where
 * it was paid", which is right for a bus fare and remains the default, so no
 * existing row changes behaviour until somebody says otherwise.
 *
 * The maths is done on elapsed milliseconds rather than whole months, because
 * reports are run over arbitrary ranges — "10 May to 20 June" has no month
 * boundary to bucket by, and proration answers it without a special case.
 */

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type Amortizable = {
  /** When it was paid for — where the spread starts. */
  date: Date;
  /** The whole cost (unit cost × quantity). */
  amount: number;
  /** Months it covers. Null, 0 or less = charged in full on `date`. */
  spreadMonths: number | null;
};

/**
 * Add whole months, clamping to the end of the target month. 31 January plus
 * one month is 28 February, not 3 March — JS would roll the overflow forward
 * and quietly stretch the window.
 */
export function addMonths(d: Date, months: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const lastDayOfTarget = new Date(
    Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0),
  ).getUTCDate();
  r.setUTCDate(Math.min(day, lastDayOfTarget));
  return r;
}

/** The half-open window `[start, end)` a cost is spread across, or null when it isn't spread. */
export function spreadWindow(p: Amortizable): { start: Date; end: Date } | null {
  if (!p.spreadMonths || p.spreadMonths <= 0) return null;
  const start = p.date;
  const end = addMonths(start, p.spreadMonths);
  // A window with no length would divide by zero; treat it as unspread.
  return end.getTime() > start.getTime() ? { start, end } : null;
}

/**
 * How much of this cost belongs to `range` — or to everything up to `now` when
 * `range` is null.
 *
 * Nothing beyond `now` is ever recognised, whichever end date the range asks
 * for: a cost cannot have been incurred in a month that hasn't happened. What
 * that leaves unrecognised is `prepaidRemaining`.
 */
export function recognizedInPeriod(
  p: Amortizable,
  range: { from: Date; to: Date } | null,
  now: Date = new Date(),
): number {
  const window = spreadWindow(p);

  // Not spread: the whole cost sits on its own date.
  if (!window) {
    if (!range) return round2(p.amount);
    return p.date >= range.from && p.date <= range.to ? round2(p.amount) : 0;
  }

  const start = window.start.getTime();
  const end = window.end.getTime();
  const totalMs = end - start;

  const from = range ? Math.max(start, range.from.getTime()) : start;
  // Capped at now in both branches — a range reaching into next year must not
  // pull next year's share of the cost into today's profit.
  const to = Math.min(end, now.getTime(), range ? range.to.getTime() : Infinity);

  const overlapMs = to - from;
  if (overlapMs <= 0) return 0;
  return round2((p.amount * overlapMs) / totalMs);
}

/**
 * The part of a spread cost that hasn't been charged to any period yet.
 *
 * The cash for it is already gone — this is the opposite of an amount still to
 * pay. It's shown next to profit so nobody reads a healthier figure as money
 * available to take out.
 */
export function prepaidRemaining(p: Amortizable, now: Date = new Date()): number {
  if (!spreadWindow(p)) return 0;
  return round2(Math.max(0, p.amount - recognizedInPeriod(p, null, now)));
}

/** Sum of what a set of purchases put into a period, and what's still prepaid. */
export function amortizeAll(
  purchases: Amortizable[],
  range: { from: Date; to: Date } | null,
  now: Date = new Date(),
): { recognized: number; prepaid: number } {
  let recognized = 0;
  let prepaid = 0;
  for (const p of purchases) {
    recognized += recognizedInPeriod(p, range, now);
    prepaid += prepaidRemaining(p, now);
  }
  return { recognized: round2(recognized), prepaid: round2(prepaid) };
}
