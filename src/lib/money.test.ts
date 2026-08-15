import { describe, expect, it } from "vitest";
import { formatMoney, round2, toneForBalance } from "@/lib/money";

describe("formatMoney", () => {
  it("groups the way a Bangladeshi reader counts", () => {
    // 300000 was "৳300,000" in the order form and "৳300000" in the product
    // list. Neither is how anyone here says three lakh.
    expect(formatMoney(300000)).toBe("৳3,00,000");
    expect(formatMoney(12500000)).toBe("৳1,25,00,000");
    expect(formatMoney(1240)).toBe("৳1,240");
  });

  it("drops .00 on whole taka and keeps paisa when there is any", () => {
    expect(formatMoney(50000)).toBe("৳50,000");
    expect(formatMoney(886.55)).toBe("৳886.55");
    // Not "৳1,240.5" — a lone decimal place reads as a typo.
    expect(formatMoney(1240.5)).toBe("৳1,240.50");
  });

  it("keeps both decimals everywhere when a column asks", () => {
    expect(formatMoney(50000, { exact: true })).toBe("৳50,000.00");
    expect(formatMoney(886.55, { exact: true })).toBe("৳886.55");
  });

  it("uses a real minus sign so columns line up", () => {
    expect(formatMoney(-500)).toBe("−৳500");
    expect(formatMoney(-1240.5)).toBe("−৳1,240.50");
  });

  it("shows a plus only when asked", () => {
    expect(formatMoney(2000)).toBe("৳2,000");
    expect(formatMoney(2000, { signed: true })).toBe("+৳2,000");
    expect(formatMoney(-2000, { signed: true })).toBe("−৳2,000");
    expect(formatMoney(0, { signed: true })).toBe("৳0");
  });

  it("never prints a negative zero", () => {
    // round2 hands back -0 often enough, and "−৳0" reads as a loss of nothing.
    expect(formatMoney(-0)).toBe("৳0");
    expect(formatMoney(-0.001)).toBe("৳0");
  });

  it("drops the symbol for a column that already has a heading", () => {
    expect(formatMoney(1240, { bare: true })).toBe("1,240");
    expect(formatMoney(-1240, { bare: true, exact: true })).toBe("−1,240.00");
  });
});

describe("toneForBalance", () => {
  it("reads a balance the way a balance reads", () => {
    expect(toneForBalance(50000)).toBe("positive");
    expect(toneForBalance(-50000)).toBe("negative");
    // Zero is neither good news nor bad; it just isn't anything.
    expect(toneForBalance(0)).toBe("muted");
  });
});

describe("round2", () => {
  it("rounds to the paisa", () => {
    expect(round2(1240.456)).toBe(1240.46);
    expect(round2(1240.454)).toBe(1240.45);
    expect(round2(1240)).toBe(1240);
  });

  it("rounds a half up, which float storage would otherwise lose", () => {
    // 1.005 is stored as 1.00499999999999989, so Math.round(1.005 * 100) is
    // 100 without the nudge. This is what the nudge is for.
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
  });

  it("treats a negative exactly as it treats its positive", () => {
    // The asymmetry in the 29 copies this replaced: the epsilon was added to
    // the value rather than the magnitude, so it always pushed upward. −1.005
    // rounded to −1.00 while 1.005 rounded to 1.01 — a difference that landed
    // on treasury outflows and negative net profits.
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(-2.675)).toBe(-2.68);
    expect(round2(-1240.456)).toBe(-1240.46);
  });

  it("hands back a plain zero, never a negative one", () => {
    expect(Object.is(round2(-0.001), 0)).toBe(true);
    expect(Object.is(round2(-0), 0)).toBe(true);
  });

  it("leaves a figure that is already rounded alone", () => {
    // Money goes through this repeatedly on its way across the app; it has to
    // be idempotent or a total would drift from its own parts.
    const once = round2(11192.455);
    expect(round2(once)).toBe(once);
  });
});
