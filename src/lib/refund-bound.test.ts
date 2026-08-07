import { describe, expect, it } from "vitest";

/**
 * The ceiling createReturn puts on a refund, isolated from the database it
 * reads. A refund is REPORTED rather than subtracted — the returned unit
 * already drops out of both revenue and cost, so taking the cash off again
 * would count the return twice. That is also why an over-refund was invisible:
 * 5,000 handed back on a 500 item was accepted and appeared in no total
 * anywhere, in any report.
 */
function maxRefund(item: { unitPrice: number; discount: number; quantity: number }, returning: number) {
  const perUnit = item.unitPrice - item.discount / Math.max(1, item.quantity);
  return Math.round((Math.max(0, perUnit * returning) + Number.EPSILON) * 100) / 100;
}

describe("refund ceiling", () => {
  it("is what the returned units were sold for", () => {
    expect(maxRefund({ unitPrice: 500, discount: 0, quantity: 2 }, 1)).toBe(500);
    expect(maxRefund({ unitPrice: 500, discount: 0, quantity: 2 }, 2)).toBe(1000);
  });

  it("takes the line's discount off first", () => {
    // Sold at 500 with 100 off the pair — 450 a piece is what came in, so 500
    // a piece is not what can go back out.
    expect(maxRefund({ unitPrice: 500, discount: 100, quantity: 2 }, 1)).toBe(450);
  });

  it("catches the fat-finger case", () => {
    const cap = maxRefund({ unitPrice: 500, discount: 0, quantity: 1 }, 1);
    expect(5000 > cap).toBe(true); // refused now; silently accepted before
  });

  it("never goes negative on a line discounted past its own price", () => {
    expect(maxRefund({ unitPrice: 100, discount: 400, quantity: 1 }, 1)).toBe(0);
  });
});
