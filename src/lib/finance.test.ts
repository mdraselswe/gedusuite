import { describe, expect, it } from "vitest";
import { splitByShare } from "./profit-share";

/**
 * The capital rollup's rule, isolated from the database it reads.
 *
 * businessCapitalSummary answers two different questions with the same rows:
 * "how much has this business spent" (all of it) and "how much of the partners'
 * capital is left" (only what their money paid for). Conflating them meant the
 * first treasury-funded purchase would have shown them overdrawn by its full
 * amount, having spent nothing of their own.
 */
function remainingCapital(input: {
  invested: number;
  /** Partner cash handed to the treasury — capital in, same as `invested`. */
  depositedToTreasury?: number;
  /** Capital the partners took back out of the treasury again. */
  treasuryWithdrawals?: number;
  spend: { amount: number; paidFromTreasury: boolean; onCredit?: boolean }[];
  miscExpense: number;
  /** Unsold stock at cost — spent capital that is still an asset. */
  inventoryValue?: number;
}): {
  totalExpenses: number;
  treasuryFundedSpend: number;
  partnerCashInTreasury: number;
  salesFundedSpend: number;
  supplierDue: number;
  capitalSpend: number;
  netInvested: number;
  remaining: number;
  capitalPlusStock: number;
} {
  const deposited = input.depositedToTreasury ?? 0;
  const treasuryWithdrawals = input.treasuryWithdrawals ?? 0;
  const netInvested = input.invested + deposited - treasuryWithdrawals;
  const totalExpenses =
    input.spend.reduce((s, x) => s + x.amount, 0) + input.miscExpense;
  const treasuryFundedSpend = input.spend
    .filter((x) => x.paidFromTreasury)
    .reduce((s, x) => s + x.amount, 0);
  // Owed, not spent: nobody's money has left for these yet.
  const supplierDue = input.spend
    .filter((x) => x.onCredit)
    .reduce((s, x) => s + x.amount, 0);
  // Treasury spending eats the partners' own money in the pot first; only the
  // excess is the shop's takings, and only that costs nobody any capital.
  const partnerCashInTreasury = Math.max(0, deposited - treasuryWithdrawals);
  const salesFundedSpend = Math.max(0, treasuryFundedSpend - partnerCashInTreasury);
  const capitalSpend = totalExpenses - salesFundedSpend - supplierDue;
  const remaining = netInvested - capitalSpend;
  return {
    totalExpenses,
    treasuryFundedSpend,
    partnerCashInTreasury,
    salesFundedSpend,
    supplierDue,
    capitalSpend,
    netInvested,
    remaining,
    capitalPlusStock: remaining + (input.inventoryValue ?? 0),
  };
}

/**
 * The other half of the same confusion: a withdrawal can take profit or take
 * capital back, and only the second changes what a partner still has in.
 * `distributionId` is what separates them — a distribution sets it, a
 * hand-entered withdrawal doesn't.
 */
function partnerCapital(input: {
  invested: number;
  /** Cash handed to the treasury. Capital in, by a different route. */
  depositedToTreasury?: number;
  withdrawals: { amount: number; fromDistribution: boolean }[];
  expenses: number;
  /** Their cut of what the treasury spent — see treasuryCapitalShares. */
  treasuryCapitalSpend?: number;
}): { withdrawn: number; capitalWithdrawn: number; netCapital: number; remaining: number } {
  const withdrawn = input.withdrawals.reduce((s, w) => s + w.amount, 0);
  const capitalWithdrawn = input.withdrawals
    .filter((w) => !w.fromDistribution)
    .reduce((s, w) => s + w.amount, 0);
  const netCapital =
    input.invested + (input.depositedToTreasury ?? 0) - capitalWithdrawn;
  return {
    withdrawn,
    capitalWithdrawn,
    netCapital,
    remaining: netCapital - input.expenses - (input.treasuryCapitalSpend ?? 0),
  };
}

/**
 * Sharing out what the treasury spent of the partners' own money.
 *
 * Pooled cash carries nobody's name, but the claim it stands against does: the
 * split follows what each partner still has in the pot. Profit share is the
 * wrong ruler here — it would charge a partner who deposited nothing, and make
 * one purchase cost two different amounts depending on whether the money went
 * via the treasury or straight to the supplier.
 */
function treasuryCapitalShares(input: {
  partners: { id: string; deposited: number; treasuryWithdrawn?: number }[];
  treasuryFundedSpend: number;
}): Record<string, number> {
  // Each stake floored on its own before they're added: one partner's
  // withdrawal can't eat another partner's deposit.
  const stakes = input.partners.map((p) => ({
    id: p.id,
    percent: Math.max(0, p.deposited - (p.treasuryWithdrawn ?? 0)),
  }));
  const pool = stakes.reduce((s, x) => s + x.percent, 0);
  const cuts = splitByShare(stakes, Math.min(input.treasuryFundedSpend, pool));
  return Object.fromEntries(cuts.map((c) => [c.id, c.amount]));
}

describe("capital taken back vs profit taken", () => {
  it("leaves capital alone when a partner takes their share of profit", () => {
    // 25,000 of profit doesn't reduce the 34,322 they still have invested.
    const r = partnerCapital({
      invested: 34322.37,
      withdrawals: [{ amount: 25000, fromDistribution: true }],
      expenses: 34322.37,
    });
    expect(r.capitalWithdrawn).toBe(0);
    expect(r.netCapital).toBeCloseTo(34322.37, 2);
    expect(r.remaining).toBeCloseTo(0, 2);
  });

  it("reduces capital when a partner takes capital back", () => {
    // The real case: evening up with a partner sitting at 25,000.
    const r = partnerCapital({
      invested: 34322.37,
      withdrawals: [{ amount: 9322.37, fromDistribution: false }],
      expenses: 34322.37,
    });
    expect(r.netCapital).toBeCloseTo(25000, 2);
    // And "remaining" has to move with it — it used to sit at zero regardless.
    expect(r.remaining).toBeCloseTo(-9322.37, 2);
  });

  it("keeps the two apart when both have happened", () => {
    const r = partnerCapital({
      invested: 50000,
      withdrawals: [
        { amount: 10000, fromDistribution: true },
        { amount: 5000, fromDistribution: false },
      ],
      expenses: 0,
    });
    expect(r.withdrawn).toBe(15000);
    expect(r.capitalWithdrawn).toBe(5000);
    expect(r.netCapital).toBe(45000);
  });

  it("is unchanged for a partner who has withdrawn nothing", () => {
    const r = partnerCapital({ invested: 25000, withdrawals: [], expenses: 25000 });
    expect(r.netCapital).toBe(25000);
    expect(r.remaining).toBe(0);
  });

  it("counts cash handed to the treasury as capital put in", () => {
    // 25,000 already in, then 10,000 handed over for the shop to spend. The
    // deposit used to sit in its own column and leave net capital at 25,000,
    // so a partner who had given more was told they hadn't.
    const r = partnerCapital({
      invested: 25000,
      depositedToTreasury: 10000,
      withdrawals: [],
      expenses: 0,
    });
    expect(r.netCapital).toBe(35000);
  });

  it("takes it back off when they take the deposit out again", () => {
    const r = partnerCapital({
      invested: 25000,
      depositedToTreasury: 10000,
      withdrawals: [{ amount: 10000, fromDistribution: false }],
      expenses: 0,
    });
    expect(r.netCapital).toBe(25000);
  });
});

describe("remaining capital vs total spend", () => {
  it("counts partner-funded spending against capital", () => {
    const r = remainingCapital({
      invested: 59322,
      spend: [{ amount: 59322, paidFromTreasury: false }],
      miscExpense: 0,
    });
    expect(r.remaining).toBe(0);
  });

  it("leaves capital untouched by a treasury-funded purchase", () => {
    // The case that used to break it: partners spend nothing, and used to be
    // shown 5,000 overdrawn for it.
    const r = remainingCapital({
      invested: 59322,
      spend: [
        { amount: 59322, paidFromTreasury: false },
        { amount: 5000, paidFromTreasury: true },
      ],
      miscExpense: 0,
    });
    expect(r.totalExpenses).toBe(64322); // the business did spend it
    expect(r.treasuryFundedSpend).toBe(5000);
    expect(r.capitalSpend).toBe(59322);
    expect(r.remaining).toBe(0); // but not out of anyone's capital
  });

  it("treats untagged spending as capital, not treasury", () => {
    // Nobody recording a payer almost always means a partner paid and forgot.
    // Guessing "treasury" would quietly inflate what's left to spend.
    const r = remainingCapital({
      invested: 10000,
      spend: [{ amount: 3000, paidFromTreasury: false }],
      miscExpense: 0,
    });
    expect(r.remaining).toBe(7000);
  });

  it("always counts a manual partner expense against capital", () => {
    const r = remainingCapital({
      invested: 10000,
      spend: [{ amount: 2000, paidFromTreasury: true }],
      miscExpense: 500,
    });
    expect(r.treasuryFundedSpend).toBe(2000);
    expect(r.capitalSpend).toBe(500);
    expect(r.remaining).toBe(9500);
  });

  it("can still go negative when partners genuinely overspend", () => {
    const r = remainingCapital({
      invested: 1000,
      spend: [{ amount: 4000, paidFromTreasury: false }],
      miscExpense: 0,
    });
    expect(r.remaining).toBe(-3000);
  });
});

describe("partner capital that went in through the treasury", () => {
  // The same 10,000 and the same 6,110 of stock, reached two ways. The shop
  // ends up in an identical position, so every capital figure has to agree —
  // and they didn't: routing the money through the treasury reported 16,110 of
  // capital still the partners', for 10,000 they had put in.
  const viaTreasury = () =>
    remainingCapital({
      invested: 0,
      depositedToTreasury: 10000,
      spend: [{ amount: 6110, paidFromTreasury: true }],
      miscExpense: 0,
      inventoryValue: 6110,
    });
  const fromPocket = () =>
    remainingCapital({
      // 6,110 of it as the credit mirroring the purchase they paid for, the
      // rest as cash handed over.
      invested: 6110,
      depositedToTreasury: 3890,
      spend: [{ amount: 6110, paidFromTreasury: false }],
      miscExpense: 0,
      inventoryValue: 6110,
    });

  it("puts the same capital in whichever route the money took", () => {
    expect(viaTreasury().netInvested).toBe(10000);
    expect(fromPocket().netInvested).toBe(10000);
  });

  it("charges the purchase to capital either way", () => {
    expect(viaTreasury().capitalSpend).toBe(6110);
    expect(fromPocket().capitalSpend).toBe(6110);
  });

  it("leaves the partners holding the same thing either way", () => {
    const a = viaTreasury();
    const b = fromPocket();
    expect(a.remaining).toBe(3890);
    expect(b.remaining).toBe(3890);
    // 3,890 still cash, 6,110 now stock — 10,000, which is what went in.
    expect(a.capitalPlusStock).toBe(10000);
    expect(b.capitalPlusStock).toBe(10000);
  });

  it("still spares capital once the pot is past what the partners put in", () => {
    // 10,000 deposited and 50,000 of takings in the same pot, 40,000 spent from
    // it: the partners' 10,000 goes first, the other 30,000 is the shop's own.
    const r = remainingCapital({
      invested: 0,
      depositedToTreasury: 10000,
      spend: [{ amount: 40000, paidFromTreasury: true }],
      miscExpense: 0,
    });
    expect(r.salesFundedSpend).toBe(30000);
    expect(r.capitalSpend).toBe(10000);
    expect(r.remaining).toBe(0);
  });

  it("leaves the pot to the shop once a partner has taken their deposit back", () => {
    // Deposit in, deposit out, then the treasury spends takings. Without the
    // withdrawal the deposit would go on shielding capital it no longer funds,
    // and remaining would read −5,000 for money nobody had spent.
    const r = remainingCapital({
      invested: 0,
      depositedToTreasury: 10000,
      treasuryWithdrawals: 10000,
      spend: [{ amount: 5000, paidFromTreasury: true }],
      miscExpense: 0,
    });
    expect(r.partnerCashInTreasury).toBe(0);
    expect(r.salesFundedSpend).toBe(5000);
    expect(r.capitalSpend).toBe(0);
    expect(r.remaining).toBe(0);
  });
});

describe("who the treasury spent it on", () => {
  it("charges it to whoever's money was in the pot, not to everyone", () => {
    // Tinny deposited, Rasel didn't. Shared by profit share instead, this would
    // charge Rasel 3,055 for a purchase funded entirely by someone else.
    const cuts = treasuryCapitalShares({
      partners: [
        { id: "tinny", deposited: 10000 },
        { id: "rasel", deposited: 0 },
      ],
      treasuryFundedSpend: 6110,
    });
    expect(cuts.tinny).toBe(6110);
    expect(cuts.rasel).toBe(0);
  });

  it("splits it by what each one has in the pot", () => {
    const cuts = treasuryCapitalShares({
      partners: [
        { id: "tinny", deposited: 8000 },
        { id: "rasel", deposited: 2000 },
      ],
      treasuryFundedSpend: 5000,
    });
    // 80/20 of the pot, not 50/50 of the shares.
    expect(cuts.tinny).toBe(4000);
    expect(cuts.rasel).toBe(1000);
  });

  it("stops once the partners' money in the pot runs out", () => {
    // 10,000 of deposits against 40,000 of spending: the other 30,000 was the
    // shop's own takings, and costs nobody any capital.
    const cuts = treasuryCapitalShares({
      partners: [
        { id: "tinny", deposited: 6000 },
        { id: "rasel", deposited: 4000 },
      ],
      treasuryFundedSpend: 40000,
    });
    expect(cuts.tinny + cuts.rasel).toBe(10000);
  });

  it("leaves out a partner who has taken their deposit back", () => {
    const cuts = treasuryCapitalShares({
      partners: [
        { id: "tinny", deposited: 10000, treasuryWithdrawn: 10000 },
        { id: "rasel", deposited: 5000 },
      ],
      treasuryFundedSpend: 5000,
    });
    expect(cuts.tinny).toBe(0);
    expect(cuts.rasel).toBe(5000);
  });

  it("doesn't let one partner's withdrawal eat another's deposit", () => {
    // The real case: Tinny leaves 3,890 in the pot for the next restock while
    // Rasel takes 888.67 of capital back out of it. Rasel's capital went into
    // stock long ago — what he's taking is sales cash, and it must not shrink
    // what the treasury still owes Tinny. Netted together it would, and her
    // 3,890 would never finish being spent however much the shop bought.
    const cuts = treasuryCapitalShares({
      partners: [
        { id: "tinny", deposited: 3890 },
        { id: "rasel", deposited: 0, treasuryWithdrawn: 888.67 },
      ],
      treasuryFundedSpend: 3890,
    });
    expect(cuts.tinny).toBe(3890);
    expect(cuts.rasel).toBe(0);
  });

  it("charges nobody when the pot is all sales money", () => {
    const cuts = treasuryCapitalShares({
      partners: [{ id: "tinny", deposited: 0 }],
      treasuryFundedSpend: 25000,
    });
    expect(cuts.tinny).toBe(0);
  });

  it("leaves one partner's balance the same whichever route their money took", () => {
    // The equivalence, now at partner level too: Tinny puts 10,000 in and
    // 6,110 of stock gets bought, and it can't matter whose hands the cash
    // passed through on the way to the supplier.
    const viaTreasury = partnerCapital({
      invested: 0,
      depositedToTreasury: 10000,
      withdrawals: [],
      expenses: 0,
      treasuryCapitalSpend: treasuryCapitalShares({
        partners: [
          { id: "tinny", deposited: 10000 },
          { id: "rasel", deposited: 0 },
        ],
        treasuryFundedSpend: 6110,
      }).tinny,
    });
    const fromPocket = partnerCapital({
      invested: 6110, // the credit mirroring the purchase she paid for
      depositedToTreasury: 3890,
      withdrawals: [],
      expenses: 6110,
    });
    expect(viaTreasury.netCapital).toBe(10000);
    expect(fromPocket.netCapital).toBe(10000);
    expect(viaTreasury.remaining).toBe(3890);
    expect(fromPocket.remaining).toBe(3890);
  });

  it("leaves the partner who funded none of it untouched either way", () => {
    const rasel = partnerCapital({
      invested: 35000,
      withdrawals: [],
      expenses: 35000,
      treasuryCapitalSpend: treasuryCapitalShares({
        partners: [
          { id: "tinny", deposited: 10000 },
          { id: "rasel", deposited: 0 },
        ],
        treasuryFundedSpend: 6110,
      }).rasel,
    });
    expect(rasel.remaining).toBe(0);
  });
});

describe("goods bought on credit", () => {
  it("takes no capital, because nobody has paid for them yet", () => {
    // 50,000 of stock on terms used to read as 50,000 of partner capital gone.
    const r = remainingCapital({
      invested: 100000,
      spend: [{ amount: 50000, paidFromTreasury: false, onCredit: true }],
      miscExpense: 0,
    });
    expect(r.totalExpenses).toBe(50000); // the goods arrived
    expect(r.supplierDue).toBe(50000); // and are owed for
    expect(r.capitalSpend).toBe(0);
    expect(r.remaining).toBe(100000); // nothing of anyone's has left
  });

  it("moves to capital once the bill is paid from a partner's pocket", () => {
    // Settling is the same row with its funding changed, so the two states
    // have to agree on the total and disagree on who bore it.
    const r = remainingCapital({
      invested: 100000,
      spend: [{ amount: 50000, paidFromTreasury: false, onCredit: false }],
      miscExpense: 0,
    });
    expect(r.supplierDue).toBe(0);
    expect(r.capitalSpend).toBe(50000);
    expect(r.remaining).toBe(50000);
  });
});

describe("capital that turned into stock", () => {
  it("is not lost, and says so", () => {
    // The figure that frightened everyone: 300,000 in, 250,000 of it now
    // sitting on the shelf, reported as 50,000 "remaining" with no mention of
    // where the rest went.
    const r = remainingCapital({
      invested: 300000,
      spend: [{ amount: 250000, paidFromTreasury: false }],
      miscExpense: 0,
      inventoryValue: 250000,
    });
    expect(r.remaining).toBe(50000);
    expect(r.capitalPlusStock).toBe(300000);
  });

  it("shows the real loss once the stock is sold below cost", () => {
    const r = remainingCapital({
      invested: 300000,
      spend: [{ amount: 250000, paidFromTreasury: false }],
      miscExpense: 0,
      inventoryValue: 0,
    });
    expect(r.capitalPlusStock).toBe(50000);
  });
});
