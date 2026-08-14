import { describe, expect, it } from "vitest";
import { sharePotSpending, type PotEvent } from "@/lib/treasury-pot";

const on = (day: string) => new Date(`2026-08-${day}T06:00:00.000Z`);
const deposit = (day: string, partnerId: string, amount: number): PotEvent => ({
  at: on(day),
  kind: "DEPOSIT",
  partnerId,
  amount,
});
const withdraw = (day: string, partnerId: string, amount: number): PotEvent => ({
  at: on(day),
  kind: "WITHDRAWAL",
  partnerId,
  amount,
});
const spend = (day: string, amount: number): PotEvent => ({ at: on(day), kind: "SPEND", amount });

const spentBy = (r: ReturnType<typeof sharePotSpending>, id: string) => r.capitalSpent.get(id) ?? 0;
const leftOf = (r: ReturnType<typeof sharePotSpending>, id: string) => r.stillInPot.get(id) ?? 0;

describe("time", () => {
  /**
   * The bug this was written for. Lifetime spending outruns lifetime deposits
   * in any shop that has been trading a while, and the old min(spend, pool)
   * then charged every partner's whole deposit the instant it arrived.
   */
  it("does not charge a deposit for spending that happened before it", () => {
    const r = sharePotSpending([spend("11", 20_350), deposit("15", "tinny", 5_000)]);
    expect(spentBy(r, "tinny")).toBe(0);
    expect(leftOf(r, "tinny")).toBe(5_000);
    expect(r.salesFunded).toBe(20_350);
  });

  it("charges a deposit for spending that happened after it", () => {
    const r = sharePotSpending([deposit("09", "tinny", 3_890), spend("11", 20_350)]);
    expect(spentBy(r, "tinny")).toBe(3_890);
    expect(leftOf(r, "tinny")).toBe(0);
    expect(r.salesFunded).toBe(16_460);
  });

  it("charges only the part of a deposit the spending reached", () => {
    const r = sharePotSpending([deposit("09", "tinny", 10_000), spend("11", 6_110)]);
    expect(spentBy(r, "tinny")).toBe(6_110);
    expect(leftOf(r, "tinny")).toBe(3_890);
    expect(r.salesFunded).toBe(0);
  });

  it("counts a deposit made the same day as the spending it paid for", () => {
    const r = sharePotSpending([spend("11", 1_000), deposit("11", "tinny", 1_000)]);
    expect(spentBy(r, "tinny")).toBe(1_000);
    expect(r.salesFunded).toBe(0);
  });

  /** The live GeduShop workspace, as it stands. */
  it("reproduces the live workspace", () => {
    const r = sharePotSpending([
      deposit("09", "tinny", 3_890),
      withdraw("09", "rasel", 888.67),
      spend("11", 20_350),
      spend("12", 1_677.85),
      spend("14", 1_677.85),
    ]);
    expect(spentBy(r, "tinny")).toBe(3_890);
    expect(spentBy(r, "rasel")).toBe(0);
    expect(leftOf(r, "tinny")).toBe(0);
    expect(r.salesFunded).toBe(19_815.7);
  });

  it("leaves a later deposit alone once the earlier one is used up", () => {
    const r = sharePotSpending([
      deposit("09", "tinny", 3_890),
      spend("11", 20_350),
      deposit("15", "tinny", 5_000),
    ]);
    // The whole point: 3,890 was spent, the 5,000 that arrived afterwards was not.
    expect(spentBy(r, "tinny")).toBe(3_890);
    expect(leftOf(r, "tinny")).toBe(5_000);
  });
});

describe("sharing between partners", () => {
  it("splits a spend by what each has in the pot at the time", () => {
    const r = sharePotSpending([
      deposit("01", "tinny", 3_890),
      deposit("01", "rasel", 6_110),
      spend("05", 2_500),
    ]);
    expect(spentBy(r, "tinny")).toBeCloseTo(972.5, 2);
    expect(spentBy(r, "rasel")).toBeCloseTo(1_527.5, 2);
    expect(spentBy(r, "tinny") + spentBy(r, "rasel")).toBeCloseTo(2_500, 2);
    expect(r.salesFunded).toBe(0);
  });

  it("charges nobody who wasn't in the pot yet", () => {
    const r = sharePotSpending([
      deposit("01", "tinny", 5_000),
      spend("05", 5_000),
      deposit("09", "rasel", 5_000),
    ]);
    expect(spentBy(r, "tinny")).toBe(5_000);
    expect(spentBy(r, "rasel")).toBe(0);
  });

  it("charges nobody when the pot is all sales money", () => {
    const r = sharePotSpending([spend("05", 9_000)]);
    expect(r.capitalSpent.size).toBe(0);
    expect(r.salesFunded).toBe(9_000);
  });
});

describe("withdrawals", () => {
  it("takes a partner's own stake back out of the pot", () => {
    const r = sharePotSpending([
      deposit("01", "tinny", 5_000),
      withdraw("03", "tinny", 2_000),
      spend("05", 5_000),
    ]);
    expect(spentBy(r, "tinny")).toBe(3_000);
    expect(r.salesFunded).toBe(2_000);
  });

  /**
   * A partner taking more out than they have left in the pot is taking sales
   * cash. Letting the stake go negative would have their withdrawal eat
   * somebody else's deposit, and the depositor's money would then never finish
   * being spent however much the treasury bought.
   */
  it("doesn't let one partner's withdrawal eat another's deposit", () => {
    const r = sharePotSpending([
      deposit("01", "tinny", 5_000),
      withdraw("03", "rasel", 4_000),
      spend("05", 5_000),
    ]);
    expect(spentBy(r, "tinny")).toBe(5_000);
    expect(spentBy(r, "rasel")).toBe(0);
    expect(r.salesFunded).toBe(0);
  });

  it("leaves the pot to the shop once a partner has taken their deposit back", () => {
    const r = sharePotSpending([
      deposit("01", "tinny", 5_000),
      withdraw("03", "tinny", 5_000),
      spend("05", 5_000),
    ]);
    expect(spentBy(r, "tinny")).toBe(0);
    expect(r.salesFunded).toBe(5_000);
  });
});

describe("the sums hold", () => {
  it("splits every spend between partner capital and sales, to the paisa", () => {
    const events: PotEvent[] = [
      deposit("01", "a", 1_234.56),
      deposit("02", "b", 765.44),
      spend("03", 999.99),
      deposit("04", "c", 500),
      spend("05", 1_500.01),
      withdraw("06", "a", 100),
      spend("07", 3_000),
    ];
    const r = sharePotSpending(events);
    const spentTotal = [...r.capitalSpent.values()].reduce((s, x) => s + x, 0);
    const spendTotal = events
      .filter((e) => e.kind === "SPEND")
      .reduce((s, e) => s + e.amount, 0);
    expect(spentTotal + r.salesFunded).toBeCloseTo(spendTotal, 2);
  });

  it("never charges a partner more than they put in", () => {
    const r = sharePotSpending([deposit("01", "tinny", 3_890), spend("05", 999_999)]);
    expect(spentBy(r, "tinny")).toBe(3_890);
    expect(leftOf(r, "tinny")).toBe(0);
  });

  it("is not affected by the order events are handed in", () => {
    const events: PotEvent[] = [
      spend("07", 3_000),
      deposit("01", "a", 2_000),
      spend("05", 1_000),
      deposit("02", "b", 1_500),
    ];
    const forwards = sharePotSpending(events);
    const backwards = sharePotSpending([...events].reverse());
    expect(backwards.salesFunded).toBe(forwards.salesFunded);
    expect(spentBy(backwards, "a")).toBe(spentBy(forwards, "a"));
    expect(spentBy(backwards, "b")).toBe(spentBy(forwards, "b"));
  });

  it("has nothing to say about an empty ledger", () => {
    const r = sharePotSpending([]);
    expect(r.capitalSpent.size).toBe(0);
    expect(r.stillInPot.size).toBe(0);
    expect(r.salesFunded).toBe(0);
  });
});
