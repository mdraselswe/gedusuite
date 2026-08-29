import { describe, expect, it } from "vitest";
import { wooLineProductIds } from "@/lib/woo";

describe("wooLineProductIds", () => {
  it("reads the product ids and quantities a website order sold", () => {
    expect(
      wooLineProductIds({
        line_items: [
          { product_id: 4211, quantity: 2, name: "Flight Starter Combo" },
          { product_id: 388, quantity: 1, name: "AA Battery Pack" },
        ],
      }),
    ).toEqual([
      { productId: 4211, quantity: 2 },
      { productId: 388, quantity: 1 },
    ]);
  });

  it("counts the same product on two lines once", () => {
    expect(
      wooLineProductIds({
        line_items: [
          { product_id: 4211, quantity: 1 },
          { product_id: 4211, quantity: 2 },
        ],
      }),
    ).toEqual([{ productId: 4211, quantity: 3 }]);
  });

  it("treats a missing quantity as one", () => {
    expect(wooLineProductIds({ line_items: [{ product_id: 4211 }] })).toEqual([
      { productId: 4211, quantity: 1 },
    ]);
  });

  it("skips lines with no usable product id", () => {
    // Fee and shipping lines, and anything hand-edited into the payload.
    expect(
      wooLineProductIds({
        line_items: [{ quantity: 1 }, { product_id: 0, quantity: 1 }, { product_id: 4211, quantity: 1 }],
      }),
    ).toEqual([{ productId: 4211, quantity: 1 }]);
  });

  it("returns nothing for a payload with no line items", () => {
    // Every lead that predates the webhook, and anything typed by hand.
    expect(wooLineProductIds(null)).toEqual([]);
    expect(wooLineProductIds({})).toEqual([]);
    expect(wooLineProductIds({ line_items: "not an array" })).toEqual([]);
  });
});
