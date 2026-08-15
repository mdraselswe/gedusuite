import { describe, expect, it } from "vitest";
import {
  rollUpBalances,
  summariseCapital,
  type BusinessCapitalSummary,
  type PartnerBalance,
  type PartnerLedgerInput,
  type PartnerSpendKind,
} from "./finance";

/**
 * The capital rules, run against the functions the app actually ships.
 *
 * These cases used to run against a copy of the arithmetic declared at the top
 * of this file — which meant partnerBalances and businessCapitalSummary had no
 * coverage at all, and the two could drift without a single test noticing. They
 * did: when the pot walk replaced the old lifetime min(spend, deposits) rule,
 * the copy kept the old one, and on the live data the two disagreed by 888.67
 * of capital spend while all thirty tests went on passing.
 *
 * So everything below builds inputs and calls the real thing. The only thing
 * this file still owns is the shape of those inputs.
 */

/** Day N of the same month — the pot is walked in date order, so dates matter. */
const on = (day: number) => new Date(Date.UTC(2026, 0, day, 6));

type Txn = PartnerLedgerInput["txns"][number];
const invest = (partnerId: string, amount: number, day = 1): Txn => ({
  partnerId,
  type: "INVESTMENT",
  amount,
  date: on(day),
  fromDistribution: false,
  movedTreasury: false,
});
const deposit = (partnerId: string, amount: number, day = 1): Txn => ({
  partnerId,
  type: "DEPOSIT_TO_TREASURY",
  amount,
  date: on(day),
  fromDistribution: false,
  movedTreasury: true,
});
const withdraw = (
  partnerId: string,
  amount: number,
  opts: { day?: number; fromDistribution?: boolean; fromTreasury?: boolean } = {},
): Txn => ({
  partnerId,
  type: "WITHDRAWAL",
  amount,
  date: on(opts.day ?? 9),
  fromDistribution: opts.fromDistribution ?? false,
  movedTreasury: opts.fromTreasury ?? false,
});
const miscTxn = (partnerId: string, amount: number, day = 1): Txn => ({
  partnerId,
  type: "EXPENSE",
  amount,
  date: on(day),
  fromDistribution: false,
  movedTreasury: false,
});

/**
 * One row of spending, described once and fed to both functions — the same way
 * one Purchase row is read by both in the app.
 *
 * `by` is the partner who paid for it out of their own pocket; `treasury` means
 * the shared pot paid. Neither set is an untagged row, which counts against
 * capital exactly as a tagged one does.
 */
type Spend = {
  amount: number;
  kind?: PartnerSpendKind | "MISC";
  by?: string;
  treasury?: boolean;
  credit?: boolean;
  day?: number;
};

function shop(input: {
  txns?: Txn[];
  spend?: Spend[];
  inventoryValue?: number;
  treasuryBalance?: number;
}): { balances: Map<string, PartnerBalance>; summary: BusinessCapitalSummary } {
  const spend = input.spend ?? [];
  const balances = rollUpBalances({
    txns: input.txns ?? [],
    partnerSpend: spend
      .filter((s) => s.by && !s.treasury)
      .map((s) => ({
        partnerId: s.by!,
        amount: s.amount,
        kind: (s.kind ?? "PRODUCT") as PartnerSpendKind,
      })),
    treasurySpend: spend
      .filter((s) => s.treasury)
      .map((s) => ({ at: on(s.day ?? 5), amount: s.amount })),
  });
  const summary = summariseCapital({
    balances: balances.values(),
    spend: spend.map((s) => ({
      amount: s.amount,
      kind: s.kind ?? "PRODUCT",
      paidFromTreasury: !!s.treasury,
      onCredit: !!s.credit,
    })),
    inventory: {
      value: input.inventoryValue ?? 0,
      units: 0,
      fromCorrections: 0,
    },
    treasuryBalance: input.treasuryBalance ?? 0,
  });
  return { balances, summary };
}

/** The one partner in a single-partner scenario. */
const only = (balances: Map<string, PartnerBalance>) => [...balances.values()][0];

describe("capital taken back vs profit taken", () => {
  it("leaves capital alone when a partner takes their share of profit", () => {
    // 25,000 of profit doesn't reduce the 34,322 they still have invested.
    const { balances } = shop({
      txns: [invest("p", 34322.37), withdraw("p", 25000, { fromDistribution: true })],
      spend: [{ amount: 34322.37, by: "p" }],
    });
    const r = only(balances);
    expect(r.capitalWithdrawn).toBe(0);
    expect(r.profitWithdrawn).toBeCloseTo(25000, 2);
    expect(r.netCapital).toBeCloseTo(34322.37, 2);
    expect(r.remaining).toBeCloseTo(0, 2);
  });

  it("reduces capital when a partner takes capital back", () => {
    // The real case: evening up with a partner sitting at 25,000.
    const { balances } = shop({
      txns: [invest("p", 34322.37), withdraw("p", 9322.37)],
      spend: [{ amount: 34322.37, by: "p" }],
    });
    const r = only(balances);
    expect(r.netCapital).toBeCloseTo(25000, 2);
    // And "remaining" has to move with it — it used to sit at zero regardless.
    expect(r.remaining).toBeCloseTo(-9322.37, 2);
  });

  it("keeps the two apart when both have happened", () => {
    const { balances } = shop({
      txns: [
        invest("p", 50000),
        withdraw("p", 10000, { fromDistribution: true }),
        withdraw("p", 5000),
      ],
    });
    const r = only(balances);
    expect(r.withdrawn).toBe(15000);
    expect(r.capitalWithdrawn).toBe(5000);
    expect(r.profitWithdrawn).toBe(10000);
    expect(r.netCapital).toBe(45000);
  });

  it("is unchanged for a partner who has withdrawn nothing", () => {
    const { balances } = shop({
      txns: [invest("p", 25000)],
      spend: [{ amount: 25000, by: "p" }],
    });
    const r = only(balances);
    expect(r.netCapital).toBe(25000);
    expect(r.remaining).toBe(0);
  });

  it("counts cash handed to the treasury as capital put in", () => {
    // 25,000 already in, then 10,000 handed over for the shop to spend. The
    // deposit used to sit in its own column and leave net capital at 25,000,
    // so a partner who had given more was told they hadn't.
    const { balances } = shop({ txns: [invest("p", 25000), deposit("p", 10000)] });
    expect(only(balances).netCapital).toBe(35000);
  });

  it("takes it back off when they take the deposit out again", () => {
    const { balances } = shop({
      txns: [invest("p", 25000), deposit("p", 10000), withdraw("p", 10000, { fromTreasury: true })],
    });
    expect(only(balances).netCapital).toBe(25000);
  });
});

describe("remaining capital vs total spend", () => {
  it("counts partner-funded spending against capital", () => {
    const { summary } = shop({
      txns: [invest("p", 59322)],
      spend: [{ amount: 59322, by: "p" }],
    });
    expect(summary.totalRemaining).toBe(0);
  });

  it("leaves capital untouched by a treasury-funded purchase", () => {
    // The case that used to break it: partners spend nothing, and used to be
    // shown 5,000 overdrawn for it.
    const { summary } = shop({
      txns: [invest("p", 59322)],
      spend: [
        { amount: 59322, by: "p" },
        { amount: 5000, treasury: true },
      ],
    });
    expect(summary.totalExpenses).toBe(64322); // the business did spend it
    expect(summary.treasuryFundedSpend).toBe(5000);
    expect(summary.capitalSpend).toBe(59322);
    expect(summary.totalRemaining).toBe(0); // but not out of anyone's capital
  });

  it("treats untagged spending as capital, not treasury", () => {
    // Nobody recording a payer almost always means a partner paid and forgot.
    // Guessing "treasury" would quietly inflate what's left to spend.
    const { summary } = shop({
      txns: [invest("p", 10000)],
      spend: [{ amount: 3000 }],
    });
    expect(summary.totalRemaining).toBe(7000);
  });

  it("always counts a manual partner expense against capital", () => {
    const { summary } = shop({
      txns: [invest("p", 10000), miscTxn("p", 500)],
      spend: [
        { amount: 2000, treasury: true },
        { amount: 500, kind: "MISC", by: "p" },
      ],
    });
    expect(summary.treasuryFundedSpend).toBe(2000);
    expect(summary.miscExpense).toBe(500);
    expect(summary.capitalSpend).toBe(500);
    expect(summary.totalRemaining).toBe(9500);
  });

  it("can still go negative when partners genuinely overspend", () => {
    const { summary } = shop({
      txns: [invest("p", 1000)],
      spend: [{ amount: 4000, by: "p" }],
    });
    expect(summary.totalRemaining).toBe(-3000);
  });
});

describe("partner capital that went in through the treasury", () => {
  // The same 10,000 and the same 6,110 of stock, reached two ways. The shop
  // ends up in an identical position, so every capital figure has to agree —
  // and they didn't: routing the money through the treasury reported 16,110 of
  // capital still the partners', for 10,000 they had put in.
  const viaTreasury = () =>
    shop({
      txns: [deposit("p", 10000, 1)],
      spend: [{ amount: 6110, treasury: true, day: 2 }],
      inventoryValue: 6110,
      treasuryBalance: 3890, // 10,000 deposited, 6,110 of it spent
    }).summary;
  const fromPocket = () =>
    shop({
      // 6,110 of it as the credit mirroring the purchase they paid for, the
      // rest as cash handed over.
      txns: [invest("p", 6110, 1), deposit("p", 3890, 1)],
      spend: [{ amount: 6110, by: "p" }],
      inventoryValue: 6110,
      treasuryBalance: 3890, // the deposit, untouched
    }).summary;

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
    expect(a.totalRemaining).toBe(3890);
    expect(b.totalRemaining).toBe(3890);
    // 3,890 still cash, 6,110 now stock — 10,000, which is what went in.
    expect(a.businessHoldings).toBe(10000);
    expect(b.businessHoldings).toBe(10000);
  });

  it("still spares capital once the pot is past what the partners put in", () => {
    // 10,000 deposited and 50,000 of takings in the same pot, 40,000 spent from
    // it: the partners' 10,000 goes first, the other 30,000 is the shop's own.
    const { summary } = shop({
      txns: [deposit("p", 10000, 1)],
      spend: [{ amount: 40000, treasury: true, day: 2 }],
    });
    expect(summary.salesFundedSpend).toBe(30000);
    expect(summary.capitalSpend).toBe(10000);
    expect(summary.totalRemaining).toBe(0);
  });

  it("leaves the pot to the shop once a partner has taken their deposit back", () => {
    // Deposit in, deposit out, then the treasury spends takings. Without the
    // withdrawal the deposit would go on shielding capital it no longer funds,
    // and remaining would read −5,000 for money nobody had spent.
    const { summary } = shop({
      txns: [deposit("p", 10000, 1), withdraw("p", 10000, { day: 2, fromTreasury: true })],
      spend: [{ amount: 5000, treasury: true, day: 3 }],
    });
    expect(summary.partnerCashInTreasury).toBe(0);
    expect(summary.salesFundedSpend).toBe(5000);
    expect(summary.capitalSpend).toBe(0);
    expect(summary.totalRemaining).toBe(0);
  });

  it("cannot spend a deposit that had not arrived yet", () => {
    // The failure the date-ordered walk exists to stop, and the one the old
    // copy of these rules could not see: a purchase made on the 2nd charged
    // against money handed over on the 9th. Lifetime totals compared as two
    // lumps, it read as capital spent and the deposit as already gone.
    const { summary, balances } = shop({
      txns: [deposit("p", 5000, 9)],
      spend: [{ amount: 5000, treasury: true, day: 2 }],
    });
    expect(summary.salesFundedSpend).toBe(5000);
    expect(summary.treasuryCapitalSpend).toBe(0);
    expect(summary.partnerCashInTreasury).toBe(5000);
    expect(only(balances).treasuryCapitalRemaining).toBe(5000);
  });
});

describe("who the treasury spent it on", () => {
  it("charges it to whoever's money was in the pot, not to everyone", () => {
    // Tinny deposited, Rasel didn't. Shared by profit share instead, this would
    // charge Rasel 3,055 for a purchase funded entirely by someone else.
    const { balances } = shop({
      txns: [deposit("tinny", 10000, 1), invest("rasel", 1, 1)],
      spend: [{ amount: 6110, treasury: true, day: 2 }],
    });
    expect(balances.get("tinny")!.treasuryCapitalSpend).toBe(6110);
    expect(balances.get("rasel")!.treasuryCapitalSpend).toBe(0);
  });

  it("splits it by what each one has in the pot", () => {
    const { balances } = shop({
      txns: [deposit("tinny", 8000, 1), deposit("rasel", 2000, 1)],
      spend: [{ amount: 5000, treasury: true, day: 2 }],
    });
    // 80/20 of the pot, not 50/50 of the shares.
    expect(balances.get("tinny")!.treasuryCapitalSpend).toBe(4000);
    expect(balances.get("rasel")!.treasuryCapitalSpend).toBe(1000);
  });

  it("stops once the partners' money in the pot runs out", () => {
    // 10,000 of deposits against 40,000 of spending: the other 30,000 was the
    // shop's own takings, and costs nobody any capital.
    const { balances } = shop({
      txns: [deposit("tinny", 6000, 1), deposit("rasel", 4000, 1)],
      spend: [{ amount: 40000, treasury: true, day: 2 }],
    });
    expect(
      balances.get("tinny")!.treasuryCapitalSpend + balances.get("rasel")!.treasuryCapitalSpend,
    ).toBe(10000);
  });

  it("leaves out a partner who has taken their deposit back", () => {
    const { balances } = shop({
      txns: [
        deposit("tinny", 10000, 1),
        withdraw("tinny", 10000, { day: 2, fromTreasury: true }),
        deposit("rasel", 5000, 1),
      ],
      spend: [{ amount: 5000, treasury: true, day: 3 }],
    });
    expect(balances.get("tinny")!.treasuryCapitalSpend).toBe(0);
    expect(balances.get("rasel")!.treasuryCapitalSpend).toBe(5000);
  });

  it("doesn't let one partner's withdrawal eat another's deposit", () => {
    // The real case: Tinny leaves 3,890 in the pot for the next restock while
    // Rasel takes 888.67 of capital back out of it. Rasel's capital went into
    // stock long ago — what he's taking is sales cash, and it must not shrink
    // what the treasury still owes Tinny. Netted together it would, and her
    // 3,890 would never finish being spent however much the shop bought.
    const { balances } = shop({
      txns: [
        deposit("tinny", 3890, 1),
        withdraw("rasel", 888.67, { day: 1, fromTreasury: true }),
      ],
      spend: [{ amount: 3890, treasury: true, day: 2 }],
    });
    expect(balances.get("tinny")!.treasuryCapitalSpend).toBe(3890);
    expect(balances.get("rasel")!.treasuryCapitalSpend).toBe(0);
  });

  it("charges nobody when the pot is all sales money", () => {
    const { balances, summary } = shop({
      txns: [invest("tinny", 1, 1)],
      spend: [{ amount: 25000, treasury: true, day: 2 }],
    });
    expect(balances.get("tinny")!.treasuryCapitalSpend).toBe(0);
    expect(summary.salesFundedSpend).toBe(25000);
  });

  it("leaves one partner's balance the same whichever route their money took", () => {
    // The equivalence, now at partner level too: Tinny puts 10,000 in and
    // 6,110 of stock gets bought, and it can't matter whose hands the cash
    // passed through on the way to the supplier.
    const viaTreasury = shop({
      txns: [deposit("tinny", 10000, 1), invest("rasel", 1, 1)],
      spend: [{ amount: 6110, treasury: true, day: 2 }],
    }).balances.get("tinny")!;
    const fromPocket = shop({
      // the credit mirroring the purchase she paid for, plus the cash handed over
      txns: [invest("tinny", 6110, 1), deposit("tinny", 3890, 1)],
      spend: [{ amount: 6110, by: "tinny" }],
    }).balances.get("tinny")!;
    expect(viaTreasury.netCapital).toBe(10000);
    expect(fromPocket.netCapital).toBe(10000);
    expect(viaTreasury.remaining).toBe(3890);
    expect(fromPocket.remaining).toBe(3890);
  });

  it("leaves the partner who funded none of it untouched either way", () => {
    const { balances } = shop({
      txns: [invest("rasel", 35000, 1), deposit("tinny", 10000, 1)],
      spend: [
        { amount: 35000, by: "rasel" },
        { amount: 6110, treasury: true, day: 2 },
      ],
    });
    expect(balances.get("rasel")!.remaining).toBe(0);
  });
});

describe("goods bought on credit", () => {
  it("takes no capital, because nobody has paid for them yet", () => {
    // 50,000 of stock on terms used to read as 50,000 of partner capital gone.
    const { summary } = shop({
      txns: [invest("p", 100000)],
      spend: [{ amount: 50000, credit: true }],
    });
    expect(summary.totalExpenses).toBe(50000); // the goods arrived
    expect(summary.supplierDue).toBe(50000); // and are owed for
    expect(summary.capitalSpend).toBe(0);
    expect(summary.totalRemaining).toBe(100000); // nothing of anyone's has left
  });

  it("moves to capital once the bill is paid from a partner's pocket", () => {
    // Settling is the same row with its funding changed, so the two states
    // have to agree on the total and disagree on who bore it.
    const { summary } = shop({
      txns: [invest("p", 100000)],
      spend: [{ amount: 50000, by: "p" }],
    });
    expect(summary.supplierDue).toBe(0);
    expect(summary.capitalSpend).toBe(50000);
    expect(summary.totalRemaining).toBe(50000);
  });
});

describe("what the business is holding", () => {
  it("counts stock at cost as well as the cash", () => {
    // The figure that frightened everyone: 300,000 in, 250,000 of it now
    // sitting on the shelf, and "remaining" alone reads as 50,000 with no
    // mention of where the rest went.
    const { summary } = shop({
      txns: [invest("p", 300000)],
      spend: [{ amount: 250000, by: "p" }],
      inventoryValue: 250000,
    });
    expect(summary.totalRemaining).toBe(50000); // capital not yet spent
    expect(summary.businessHoldings).toBe(250000); // and the shelf it turned into
  });

  it("doesn't fall when stock is sold at a profit", () => {
    // The bug this replaced: the old figure ignored the treasury, so selling
    // 250,000 of stock for 320,000 emptied the shelf, put the money somewhere
    // it couldn't see, and reported the shop as worse off for trading well.
    const { summary } = shop({
      txns: [invest("p", 300000)],
      spend: [{ amount: 250000, by: "p" }],
      inventoryValue: 0,
      treasuryBalance: 320000,
    });
    expect(summary.businessHoldings).toBe(320000);
  });

  it("shows the real loss once the stock is sold below cost", () => {
    const { summary } = shop({
      txns: [invest("p", 300000)],
      spend: [{ amount: 250000, by: "p" }],
      inventoryValue: 0,
      treasuryBalance: 200000,
    });
    expect(summary.businessHoldings).toBe(200000);
  });

  it("takes off what's owed for stock bought on credit", () => {
    // 50,000 of the shelf isn't paid for, so it isn't the shop's to count.
    const { summary } = shop({
      spend: [{ amount: 50000, credit: true }],
      inventoryValue: 50000,
    });
    expect(summary.businessHoldings).toBe(0);
  });
});
