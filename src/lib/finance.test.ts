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
  spend: { amount: number; paidFromTreasury: boolean }[];
  miscExpense: number;
}): { totalExpenses: number; treasuryFundedSpend: number; capitalSpend: number; remaining: number } {
  const totalExpenses =
    input.spend.reduce((s, x) => s + x.amount, 0) + input.miscExpense;
  const treasuryFundedSpend = input.spend
    .filter((x) => x.paidFromTreasury)
    .reduce((s, x) => s + x.amount, 0);
  const capitalSpend = totalExpenses - treasuryFundedSpend;
  return {
    totalExpenses,
    treasuryFundedSpend,
    capitalSpend,
    remaining: input.invested - capitalSpend,
  };
}

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
