import { describe, expect, it } from "vitest";
import {
  allocateComboPrice,
  comboBuildable,
  comboPricePayload,
  componentsTotal,
  mergeByWebsiteProduct,
  stockShortfall,
  type ComboComponent,
} from "@/lib/combos";

// "Flight Starter": one aeroplane at 900, three batteries at 216.67 each.
// Lists for 1,550; sells for 1,200. The saving is 350.
const FLIGHT: ComboComponent[] = [
  { productVariantId: "plane", quantity: 1, salePrice: 900 },
  { productVariantId: "battery", quantity: 3, salePrice: 216.67 },
];

describe("comboBuildable", () => {
  it("is limited by the scarcest component, per set", () => {
    // 10 planes, 7 batteries, 3 batteries per set -> 2 sets.
    const stock = new Map([["plane", 10], ["battery", 7]]);
    expect(comboBuildable(FLIGHT, stock)).toBe(2);
  });

  it("is zero when any component is out", () => {
    expect(comboBuildable(FLIGHT, new Map([["plane", 5], ["battery", 0]]))).toBe(0);
  });

  it("is zero when a component has never been stocked at all", () => {
    // An absent key is not the same as a zero, and the map only ever carries
    // variants something has happened to.
    expect(comboBuildable(FLIGHT, new Map([["plane", 5]]))).toBe(0);
  });

  it("is zero for a recipe with no components", () => {
    // min() over nothing is Infinity — this would have advertised an unlimited
    // supply of an empty box.
    expect(comboBuildable([], new Map())).toBe(0);
  });

  it("never reports a negative count from negative stock", () => {
    expect(comboBuildable(FLIGHT, new Map([["plane", -3], ["battery", 9]]))).toBe(0);
  });
});

describe("componentsTotal", () => {
  it("is what the same goods list for bought separately", () => {
    expect(componentsTotal(FLIGHT)).toBe(1550.01);
  });

  it("counts an unpriced component as nothing rather than failing", () => {
    expect(componentsTotal([{ productVariantId: "x", quantity: 2, salePrice: null }])).toBe(0);
  });
});

describe("allocateComboPrice", () => {
  it("keeps catalogue prices and puts the saving in the discounts", () => {
    const lines = allocateComboPrice(FLIGHT, 1200);
    expect(lines.map((l) => l.unitPrice)).toEqual([900, 216.67]);
    expect(lines.map((l) => l.quantity)).toEqual([1, 3]);
  });

  it("splits the saving in proportion to what each line is worth", () => {
    const lines = allocateComboPrice(FLIGHT, 1200);
    // plane is 900/1550.01 of the value, batteries 650.01/1550.01.
    expect(lines[0].discount).toBeCloseTo(203.23, 2);
    expect(lines[1].discount).toBeCloseTo(146.78, 2);
  });

  it("makes the discounts sum to exactly the saving", () => {
    // The property that matters: an invoice one paisa off its own total is
    // unfindable. The last line absorbs the rounding remainder.
    const lines = allocateComboPrice(FLIGHT, 1200);
    const sum = lines.reduce((s, l) => s + l.discount, 0);
    expect(Math.round(sum * 100) / 100).toBe(350.01);
  });

  it("scales quantities and the saving by the number of sets", () => {
    const lines = allocateComboPrice(FLIGHT, 1200, 2);
    expect(lines.map((l) => l.quantity)).toEqual([2, 6]);
    const sum = lines.reduce((s, l) => s + l.discount, 0);
    expect(Math.round(sum * 100) / 100).toBe(700.02);
  });

  it("gives no discount when the combo is not actually cheaper", () => {
    // Priced at or above the parts: the customer still pays the combo price,
    // but there is no saving to spread, and a negative one would read as
    // negative revenue downstream.
    const lines = allocateComboPrice(FLIGHT, 1800);
    expect(lines.every((l) => l.discount === 0)).toBe(true);
  });

  it("splits by piece count when nothing has a price to be proportional to", () => {
    const unpriced: ComboComponent[] = [
      { productVariantId: "a", quantity: 1, salePrice: null },
      { productVariantId: "b", quantity: 3, salePrice: null },
    ];
    // Nothing lists for anything, so there is no saving either — but the split
    // must still not divide by zero.
    const lines = allocateComboPrice(unpriced, 500);
    expect(lines.map((l) => l.discount)).toEqual([0, 0]);
    expect(lines.map((l) => l.quantity)).toEqual([1, 3]);
  });

  it("never returns a negative discount", () => {
    const lines = allocateComboPrice(FLIGHT, 1200, 3);
    expect(lines.every((l) => l.discount >= 0)).toBe(true);
  });

  it("returns nothing for an empty recipe or a zero quantity", () => {
    expect(allocateComboPrice([], 1200)).toEqual([]);
    expect(allocateComboPrice(FLIGHT, 1200, 0)).toEqual([]);
  });
});

describe("comboPricePayload", () => {
  it("keeps a higher regular price and writes the combo price as the sale", () => {
    // The shop is showing "149 struck through, 120 to pay". Pushing the combo
    // must not flatten that to a plain 120.
    expect(comboPricePayload(120, 149)).toEqual({ sale_price: "120" });
  });

  it("sets the regular price when the website has none", () => {
    expect(comboPricePayload(120, 0)).toEqual({ regular_price: "120", sale_price: "" });
  });

  it("clears a stale sale price when the combo price catches up", () => {
    // Regular 120, combo now 120: an old sale price left standing would keep
    // selling at a price this app no longer asks for.
    expect(comboPricePayload(120, 120)).toEqual({ regular_price: "120", sale_price: "" });
  });

  it("takes over a regular price the combo has risen above", () => {
    expect(comboPricePayload(160, 149)).toEqual({ regular_price: "160", sale_price: "" });
  });
});

describe("mergeByWebsiteProduct", () => {
  it("adds together variants the website sells as one product", () => {
    // Red and Blue are two shelves here and one listing there.
    expect(
      mergeByWebsiteProduct([
        { wooProductId: 2396, quantity: 1 },
        { wooProductId: 2396, quantity: 2 },
      ]),
    ).toEqual([{ id: 2396, qty: 3 }]);
  });

  it("is what stops the website overselling a merged recipe", () => {
    // Unmerged, the website reads two rows and answers min(10/1, 10/2) = 5
    // sets. There is stock for three. This is the whole reason for merging.
    const merged = mergeByWebsiteProduct([
      { wooProductId: 2396, quantity: 1 },
      { wooProductId: 2396, quantity: 2 },
    ]);
    const stock = 10;
    const buildable = Math.min(...merged.map((m) => Math.floor(stock / m.qty)));
    expect(buildable).toBe(3);
  });

  it("leaves distinct products alone", () => {
    expect(
      mergeByWebsiteProduct([
        { wooProductId: 2620, quantity: 2 },
        { wooProductId: 2614, quantity: 2 },
      ]),
    ).toEqual([
      { id: 2620, qty: 2 },
      { id: 2614, qty: 2 },
    ]);
  });

  it("keeps first-seen order so the box reads the way it was written", () => {
    expect(
      mergeByWebsiteProduct([
        { wooProductId: 30, quantity: 1 },
        { wooProductId: 10, quantity: 1 },
        { wooProductId: 30, quantity: 1 },
      ]),
    ).toEqual([
      { id: 30, qty: 2 },
      { id: 10, qty: 1 },
    ]);
  });

  it("has nothing to say about an empty recipe", () => {
    expect(mergeByWebsiteProduct([])).toEqual([]);
  });
});

describe("a buy-one-get-one, which is one product taken twice", () => {
  // "Buy 1 get 1" on a ৳79 keychain: the set is two pieces at the price of
  // one. Nothing about it is special — it is an ordinary recipe with a single
  // component — which is the point.
  const BOGO: ComboComponent[] = [{ productVariantId: "keychain", quantity: 2, salePrice: 79 }];

  it("lists for two and sells for one", () => {
    expect(componentsTotal(BOGO)).toBe(158);
  });

  it("gives the whole saving to the one line", () => {
    expect(allocateComboPrice(BOGO, 79, 1)).toEqual([
      { productVariantId: "keychain", quantity: 2, unitPrice: 79, discount: 79 },
    ]);
  });

  it("counts a set for every two on the shelf", () => {
    expect(comboBuildable(BOGO, new Map([["keychain", 11]]))).toBe(5);
    expect(comboBuildable(BOGO, new Map([["keychain", 1]]))).toBe(0);
  });

  it("scales when somebody takes two of the offer", () => {
    // Two BOGOs = four pieces for the price of two.
    expect(allocateComboPrice(BOGO, 79, 2)).toEqual([
      { productVariantId: "keychain", quantity: 4, unitPrice: 79, discount: 158 },
    ]);
  });

  it("handles buy two get three the same way", () => {
    const B2G3: ComboComponent[] = [{ productVariantId: "toy", quantity: 3, salePrice: 100 }];
    expect(componentsTotal(B2G3)).toBe(300);
    expect(allocateComboPrice(B2G3, 200, 1)).toEqual([
      { productVariantId: "toy", quantity: 3, unitPrice: 100, discount: 100 },
    ]);
  });
});

describe("stockShortfall", () => {
  it("adds a combo's pieces to the loose ones before judging", () => {
    // Two combos with an aeroplane each, plus one on its own: three wanted,
    // two on the shelf. Judged per combo this passes — each set is buildable.
    expect(
      stockShortfall(
        [
          { productVariantId: "plane", quantity: 1 },
          { productVariantId: "plane", quantity: 1 },
          { productVariantId: "plane", quantity: 1 },
        ],
        new Map([["plane", 2]]),
      ),
    ).toEqual([{ productVariantId: "plane", need: 3, have: 2 }]);
  });

  it("says nothing when the shelf covers it exactly", () => {
    expect(
      stockShortfall(
        [
          { productVariantId: "plane", quantity: 2 },
          { productVariantId: "plane", quantity: 1 },
        ],
        new Map([["plane", 3]]),
      ),
    ).toEqual([]);
  });

  it("reports each short variant once, with the total wanted", () => {
    expect(
      stockShortfall(
        [
          { productVariantId: "a", quantity: 2 },
          { productVariantId: "b", quantity: 1 },
          { productVariantId: "a", quantity: 2 },
        ],
        new Map([
          ["a", 3],
          ["b", 5],
        ]),
      ),
    ).toEqual([{ productVariantId: "a", need: 4, have: 3 }]);
  });

  it("treats a variant it knows no stock for as having none", () => {
    expect(stockShortfall([{ productVariantId: "ghost", quantity: 1 }], new Map())).toEqual([
      { productVariantId: "ghost", need: 1, have: 0 },
    ]);
  });

  it("ignores rows asking for nothing", () => {
    expect(
      stockShortfall(
        [
          { productVariantId: "a", quantity: 0 },
          { productVariantId: "a", quantity: -1 },
        ],
        new Map([["a", 0]]),
      ),
    ).toEqual([]);
  });
});
