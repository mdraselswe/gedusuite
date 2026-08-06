import { describe, expect, it } from "vitest";
import { sharesAreNormalized, splitByShare } from "@/lib/profit-share";

const sum = (cuts: { amount: number }[]) =>
  Math.round(cuts.reduce((s, c) => s + c.amount, 0) * 100) / 100;

describe("splitByShare", () => {
  it("splits evenly when the shares are even", () => {
    const cuts = splitByShare([{ percent: 50 }, { percent: 50 }], 10000);
    expect(cuts.map((c) => c.amount)).toEqual([5000, 5000]);
  });

  it("normalizes against the total in use, not against 100", () => {
    // 60/30 assigns the whole amount as 66.67/33.33 rather than leaving 10%
    // belonging to nobody — this is the disagreement the module exists to end.
    const cuts = splitByShare([{ percent: 60 }, { percent: 30 }], 10000);
    expect(cuts.map((c) => c.amount)).toEqual([6666.67, 3333.33]);
    expect(cuts.map((c) => c.effectivePercent)).toEqual([66.67, 33.33]);
  });

  it("assigns every last paisa, remainder to the largest share", () => {
    const cuts = splitByShare([{ percent: 33.33 }, { percent: 33.33 }, { percent: 33.34 }], 10000);
    expect(sum(cuts)).toBe(10000);
    expect(cuts[2].amount).toBe(3334); // the largest share carries the rounding
  });

  it("assigns everything on awkward amounts too", () => {
    for (const amount of [0.03, 100.01, 12345.67, 7777.77, 1, 0.01]) {
      expect(sum(splitByShare([{ percent: 70 }, { percent: 20 }, { percent: 5 }], amount))).toBe(
        Math.round(amount * 100) / 100,
      );
    }
  });

  it("shares a loss the same way it shares a profit", () => {
    const cuts = splitByShare([{ percent: 60 }, { percent: 40 }], -5000.55);
    expect(cuts.map((c) => c.amount)).toEqual([-3000.33, -2000.22]);
    expect(sum(cuts)).toBe(-5000.55);
  });

  it("handles shares that total more than 100", () => {
    const cuts = splitByShare([{ percent: 80 }, { percent: 80 }], 9000);
    expect(cuts.map((c) => c.amount)).toEqual([4500, 4500]);
  });

  it("gives one partner the lot", () => {
    expect(splitByShare([{ percent: 40 }], 7777.77)[0]).toMatchObject({
      effectivePercent: 100,
      amount: 7777.77,
    });
  });

  it("assigns nothing — and no NaN — when every share is zero", () => {
    const cuts = splitByShare([{ percent: 0 }, { percent: 0 }], 5000);
    expect(cuts.map((c) => c.amount)).toEqual([0, 0]);
    expect(cuts.map((c) => c.effectivePercent)).toEqual([0, 0]);
  });

  it("copes with no partners at all", () => {
    expect(splitByShare([], 5000)).toEqual([]);
  });

  it("carries the caller's own fields through", () => {
    const cuts = splitByShare([{ id: "a", name: "Rasel", percent: 100 }], 500);
    expect(cuts[0]).toMatchObject({ id: "a", name: "Rasel", amount: 500 });
  });
});

describe("sharesAreNormalized", () => {
  it("is true at exactly 100 and for an empty list", () => {
    expect(sharesAreNormalized([{ percent: 60 }, { percent: 40 }])).toBe(true);
    expect(sharesAreNormalized([])).toBe(true);
    expect(sharesAreNormalized([{ percent: 0 }])).toBe(true);
  });

  it("is false when the shares don't reach 100 or overshoot it", () => {
    expect(sharesAreNormalized([{ percent: 60 }, { percent: 30 }])).toBe(false);
    expect(sharesAreNormalized([{ percent: 80 }, { percent: 80 }])).toBe(false);
  });
});
