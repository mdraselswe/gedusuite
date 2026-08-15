/**
 * Splitting money across partners by profit share.
 *
 * There is one rule and it lives here, because there used to be two. A
 * distribution normalized each partner's percent against the total actually in
 * use — 60/30 pays out 66.67/33.33, so the whole amount gets assigned — while
 * every screen that showed a partner "your share" multiplied by the raw
 * percent instead, leaving 10% of the money belonging to nobody. A partner
 * therefore read one number all month and was paid a different one, and
 * neither was wrong on its own terms.
 */

import { round2 } from "@/lib/money";

export type ShareHolder = { percent: number };

export type Share<T> = T & {
  /** What the partner's record says. */
  percent: number;
  /** The percent after normalizing against the total in use — what they're paid on. */
  effectivePercent: number;
  amount: number;
};

/**
 * Split `amount` across partners by profit share.
 *
 * Percents are normalized against their own total rather than against 100, so
 * the full amount is always assigned however the shares were set. The rounding
 * remainder — a few paisa either way — goes to the largest share: arbitrary,
 * but consistent, and the cuts sum to exactly `amount`.
 *
 * `amount` may be negative. A loss is shared the same way a profit is, and a
 * partner's share of it is theirs too.
 */
export function splitByShare<T extends ShareHolder>(partners: T[], amount: number): Share<T>[] {
  const totalPercent = partners.reduce((s, p) => s + p.percent, 0);
  // Nothing to normalize against: every share is zero rather than a division
  // by zero, and no money is assigned to anyone.
  if (totalPercent <= 0) {
    return partners.map((p) => ({ ...p, effectivePercent: 0, amount: 0 }));
  }

  const cuts: Share<T>[] = partners.map((p) => ({
    ...p,
    effectivePercent: round2((p.percent / totalPercent) * 100),
    amount: round2((p.percent / totalPercent) * amount),
  }));

  const remainder = round2(amount - round2(cuts.reduce((s, c) => s + c.amount, 0)));
  if (remainder !== 0) {
    const largest = cuts.reduce((max, c) => (c.percent > max.percent ? c : max), cuts[0]);
    largest.amount = round2(largest.amount + remainder);
  }
  return cuts;
}

/**
 * How much of a proposed distribution isn't profit.
 *
 * Zero or less means it's covered. `distributableProfit` is what's LEFT —
 * earnings less everything already handed out — because the lifetime total
 * never moves when partners are paid, and asking it twice gives the same
 * answer twice. That is how the same 200,000 gets distributed in March and
 * again in April with nothing objecting.
 *
 * Both ends are floored at zero. A business already overdrawn on its profit
 * must not make the next payout look free, and a payout well inside the profit
 * is not "negatively beyond" it — it's simply covered.
 *
 * Lives here rather than in finance.ts so the dialog that previews the warning
 * and the server action that enforces it run the same line of code — finance.ts
 * reaches for the database and can't be imported by a client component.
 */
export function beyondDistributableProfit(
  distributableProfit: number,
  amount: number,
): number {
  return round2(Math.max(0, amount - Math.max(0, distributableProfit)));
}

/**
 * Do the partners' percents already add up to 100? When they don't, the
 * normalization above quietly changes what each one is paid, and the screens
 * say so rather than showing two different percentages with no explanation.
 */
export function sharesAreNormalized(partners: ShareHolder[]): boolean {
  const total = round2(partners.reduce((s, p) => s + p.percent, 0));
  return total === 0 || total === 100;
}
