import { splitByShare } from "@/lib/profit-share";

/**
 * Whose money the treasury spent, in the order it actually happened.
 *
 * The pot holds two kinds of money — capital partners have deposited into it,
 * and the shop's own takings — and a purchase paid out of it consumes the
 * partners' share first. That rule is right and stays. What was missing was
 * time.
 *
 * The old arithmetic compared two lifetime sums: every treasury-funded purchase
 * ever made against every partner deposit ever made, charged as
 * `min(spend, pool)`. Once lifetime spending passed lifetime deposits — true of
 * any shop that has been trading a while — every partner's whole deposit read
 * as spent, permanently and from the instant it landed. In the live workspace a
 * partner could have deposited 5,000 on a Tuesday and watched their "remaining"
 * not move, because purchases made the previous week had already been charged
 * against money that did not exist when they were made.
 *
 * So the pot is walked as a ledger instead. Each spend can only consume what
 * was in the pot at that moment, split across whoever's money was in it then;
 * anything left over is the shop's own takings and costs nobody any capital. A
 * deposit that arrives after the spending is simply still there.
 *
 * Pure, and deliberately kept out of finance.ts: this is the arithmetic worth
 * testing, and finance.ts is where the database lives.
 */

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type PotEventKind = "DEPOSIT" | "WITHDRAWAL" | "SPEND";

export type PotEvent = {
  at: Date;
  kind: PotEventKind;
  /** Whose deposit or withdrawal. Absent on a spend — the pot pays as one. */
  partnerId?: string;
  amount: number;
};

export type PotShare = {
  /** Per partner: how much of their deposited capital the treasury has spent. */
  capitalSpent: Map<string, number>;
  /** Per partner: what of their deposit is still sitting unspent in the pot. */
  stillInPot: Map<string, number>;
  /** What the partners' money in the pot didn't cover — the shop's own takings. */
  salesFunded: number;
};

/**
 * Same instant, different kinds: a deposit counts before the spending it was
 * made for, and a withdrawal takes only what survived it.
 *
 * Most rows carry a real timestamp and never reach this, but a date-only entry
 * and a purchase on the same day are common, and "I put the money in this
 * morning and bought stock with it this afternoon" is what that pair almost
 * always means.
 */
const KIND_ORDER: Record<PotEventKind, number> = { DEPOSIT: 0, SPEND: 1, WITHDRAWAL: 2 };

export function sharePotSpending(events: PotEvent[]): PotShare {
  const ordered = [...events].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );

  const inPot = new Map<string, number>();
  const capitalSpent = new Map<string, number>();
  let salesFunded = 0;

  const bump = (map: Map<string, number>, id: string, by: number) =>
    map.set(id, round2((map.get(id) ?? 0) + by));

  for (const event of ordered) {
    if (event.kind === "DEPOSIT") {
      if (event.partnerId) bump(inPot, event.partnerId, event.amount);
      continue;
    }

    if (event.kind === "WITHDRAWAL") {
      if (!event.partnerId) continue;
      // Floored at that partner's own stake, never taken negative. A partner
      // withdrawing more than they have left in the pot is taking sales cash —
      // their own capital went into stock months ago — and letting it go below
      // zero would have their withdrawal eat somebody else's deposit.
      const left = inPot.get(event.partnerId) ?? 0;
      inPot.set(event.partnerId, round2(Math.max(0, left - event.amount)));
      continue;
    }

    // A spend. Whoever has money in the pot right now funds it, in proportion
    // to what each of them has in it — pooled cash carries no name, but a
    // capital account is about whose claim shrinks.
    const stakes = [...inPot.entries()]
      .filter(([, amount]) => amount > 0)
      .map(([partnerId, percent]) => ({ partnerId, percent }));
    const pool = round2(stakes.reduce((s, x) => s + x.percent, 0));
    const fromPartners = Math.min(event.amount, pool);

    if (fromPartners > 0) {
      // splitByShare normalizes the weights and hands the rounding remainder to
      // the biggest one, so the cuts add up to exactly what was consumed.
      for (const cut of splitByShare(stakes, fromPartners)) {
        bump(capitalSpent, cut.partnerId, cut.amount);
        const left = inPot.get(cut.partnerId) ?? 0;
        inPot.set(cut.partnerId, round2(Math.max(0, left - cut.amount)));
      }
    }
    salesFunded = round2(salesFunded + (event.amount - fromPartners));
  }

  return { capitalSpent, stillInPot: inPot, salesFunded: round2(salesFunded) };
}
