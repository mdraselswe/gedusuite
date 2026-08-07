/**
 * How money is written down, in one place.
 *
 * There were three ways before this file: `toLocaleString("en-US")` in the
 * order form, a bare `৳${n}` in the product list, and a raw `.toFixed(2)` in
 * roughly two hundred other places. So the same 312450 appeared as "৳312,450",
 * "৳312450" and "312450.00" on three screens of the same app, and a number
 * grouped the American way is one a Bangladeshi reader has to stop and count.
 *
 * Deliberately a plain function rather than a component: reports export to
 * XLSX and PDF, notification messages are built server-side, and all of them
 * need the same string as the screen.
 */

/**
 * Bangladeshi grouping — lakh and crore, not thousands. 300000 is 3,00,000
 * here and 300,000 under en-US, and only one of those can be read at a glance
 * by the person using this shop's books. `en-IN` is the locale that implements
 * the South Asian grouping; there is no widely-supported `bn-BD` numeric
 * grouping in every runtime, and the digits stay Latin either way, which is
 * what the Bangla setting wants anyway (see the note on Bangla script in the
 * terminal — the same reasoning applies to figures people type back).
 */
const GROUPING_LOCALE = "en-IN";

export const TAKA = "৳";

/** A real minus sign, not a hyphen: −1,240 lines up, -1,240 doesn't. */
const MINUS = "−";

export type MoneyFormat = {
  /**
   * Always show two decimals. Off by default — "৳50,000" reads faster than
   * "৳50,000.00" and most figures in this app are whole taka. Turn it on for
   * anything in a column, where a ragged decimal point is worse than a noisy
   * one.
   */
  exact?: boolean;
  /** Show a + on positive values. For deltas, where direction is the point. */
  signed?: boolean;
  /** Drop the ৳. For a column already headed "Amount". */
  bare?: boolean;
};

/** `৳1,24,000` · `−৳500.50` · `+৳2,000` */
export function formatMoney(value: number, opts: MoneyFormat = {}): string {
  // Everything below is decided from the value ROUNDED to the precision that
  // will actually be shown, never from the raw one. Money arrives here after
  // several rounds of arithmetic, so −0.001 and −0 both turn up regularly —
  // and reading the sign off the raw figure printed them as "−৳0.00", a loss
  // of nothing, which is the sort of thing that gets a treasury page
  // screenshotted and questioned.
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  const fractionDigits = opts.exact || rounded % 1 !== 0 ? 2 : 0;
  const sign = rounded === 0 ? "" : value < 0 ? MINUS : opts.signed ? "+" : "";
  const symbol = opts.bare ? "" : TAKA;
  const digits = rounded.toLocaleString(GROUPING_LOCALE, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `${sign}${symbol}${digits}`;
}

/**
 * What a figure means, not what it is.
 *
 * Kept apart from the sign on purpose. Expenses of ৳3,12,450 are a positive
 * number and emphatically not good news; capital remaining of ৳50,000 is
 * positive and fine. Colour follows the meaning the screen assigns, so every
 * caller says which it is rather than the formatter guessing from a minus sign.
 */
export type MoneyTone = "neutral" | "positive" | "negative" | "muted";

/** Tailwind classes per tone, shared so profit is the same green everywhere. */
export const moneyToneClass: Record<MoneyTone, string> = {
  neutral: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-destructive",
  muted: "text-muted-foreground",
};

/**
 * The common case: a figure that is good when it's up and bad when it's below
 * zero — profit, a balance, capital remaining. Anything where that isn't true
 * should pass its tone explicitly instead of reaching for this.
 */
export function toneForBalance(value: number): MoneyTone {
  if (value < 0) return "negative";
  if (value > 0) return "positive";
  return "muted";
}
