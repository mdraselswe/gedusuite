import { describe, expect, it } from "vitest";

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
  spend: { amount: number; paidFromTreasury: boolean; onCredit?: boolean }[];
  miscExpense: number;
  /** Unsold stock at cost — spent capital that is still an asset. */
  inventoryValue?: number;
}): {
  totalExpenses: number;
  treasuryFundedSpend: number;
  supplierDue: number;
  capitalSpend: number;
  remaining: number;
  capitalPlusStock: number;
} {
  const totalExpenses =
    input.spend.reduce((s, x) => s + x.amount, 0) + input.miscExpense;
  const treasuryFundedSpend = input.spend
    .filter((x) => x.paidFromTreasury)
    .reduce((s, x) => s + x.amount, 0);
  // Owed, not spent: nobody's money has left for these yet.
  const supplierDue = input.spend
    .filter((x) => x.onCredit)
    .reduce((s, x) => s + x.amount, 0);
  const capitalSpend = totalExpenses - treasuryFundedSpend - supplierDue;
  const remaining = input.invested - capitalSpend;
  return {
    totalExpenses,
    treasuryFundedSpend,
    supplierDue,
    capitalSpend,
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
  withdrawals: { amount: number; fromDistribution: boolean }[];
  expenses: number;
}): { withdrawn: number; capitalWithdrawn: number; netCapital: number; remaining: number } {
  const withdrawn = input.withdrawals.reduce((s, w) => s + w.amount, 0);
  const capitalWithdrawn = input.withdrawals
    .filter((w) => !w.fromDistribution)
    .reduce((s, w) => s + w.amount, 0);
  const netCapital = input.invested - capitalWithdrawn;
  return { withdrawn, capitalWithdrawn, netCapital, remaining: netCapital - input.expenses };
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
