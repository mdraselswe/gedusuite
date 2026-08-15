import { describe, expect, it } from "vitest";
import { variantCost } from "./inventory";

/**
 * The cost chain, which decides what the shelf is worth and what a write-off
 * cost. It was written out by hand in four places and one of them had only the
 * middle link, which is how the product detail page came to value 54 of this
 * shop's 73 stocked variants at nothing.
 */
describe("variantCost", () => {
  it("prefers what it last cost to buy", () => {
    expect(variantCost({ unitCost: 150, purchases: [{ unitCost: 210 }] })).toBe(210);
  });

  it("falls back to the catalogue cost when nothing has been bought", () => {
    expect(variantCost({ unitCost: 150, purchases: [] })).toBe(150);
  });

  it("is zero when neither is known, not NaN", () => {
    expect(variantCost({ unitCost: null, purchases: [] })).toBe(0);
  });

  it("takes the purchase price even when the catalogue has nothing", () => {
    // The common shape in this shop: the real cost is typed on the purchase
    // form and the catalogue field is left empty.
    expect(variantCost({ unitCost: null, purchases: [{ unitCost: 322 }] })).toBe(322);
  });

  it("reads a Decimal as a number", () => {
    // Prisma hands these over as Decimal objects, not numbers.
    expect(variantCost({ unitCost: null, purchases: [{ unitCost: { toString: () => "2.08" } }] })).toBe(2.08);
  });

  it("keeps a free piece at zero rather than treating it as unknown", () => {
    expect(variantCost({ unitCost: null, purchases: [{ unitCost: 0 }] })).toBe(0);
  });
});
