import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIERS,
  bandLines,
  compareResellerRows,
  parseBands,
  parseOverrides,
  parseTiers,
  priceVariant,
  resellerRow,
  roundUpTo,
  tierLabel,
  tiersForBands,
} from "@/lib/reseller-pricing";

const settings = { tiers: DEFAULT_TIERS, minMarginPct: 10, roundTo: 5 };

describe("parseTiers", () => {
  it("sorts bands and always starts at one piece", () => {
    expect(parseTiers([{ minQty: 10, discountPct: 20 }, { minQty: 5, discountPct: 15 }])).toEqual([
      { minQty: 1, discountPct: 0 },
      { minQty: 5, discountPct: 15 },
      { minQty: 10, discountPct: 20 },
    ]);
  });

  it("drops duplicates and nonsense, and falls back to defaults when nothing is left", () => {
    expect(parseTiers([{ minQty: 1, discountPct: 10 }, { minQty: 1, discountPct: 50 }])).toEqual([
      { minQty: 1, discountPct: 10 },
    ]);
    expect(parseTiers([{ minQty: 0, discountPct: 10 }, { minQty: 3, discountPct: 120 }])).toEqual(DEFAULT_TIERS);
    expect(parseTiers("garbage")).toEqual(DEFAULT_TIERS);
  });
});

describe("tierLabel", () => {
  it("names each band by the quantities it covers", () => {
    expect(DEFAULT_TIERS.map((_, i) => tierLabel(DEFAULT_TIERS, i))).toEqual(["1–4 pcs", "5–9 pcs", "10+ pcs"]);
    const tight = [{ minQty: 1, discountPct: 5 }, { minQty: 2, discountPct: 10 }];
    expect(tierLabel(tight, 0)).toBe("1 pc");
  });
});

describe("a product's own bands", () => {
  it("reads them sorted, deduped, starting at one piece", () => {
    expect(parseBands([6, 2, 2, "x", 0])).toEqual([1, 2, 6]);
    expect(parseBands([1, 5])).toEqual([1, 5]);
    expect(parseBands(null)).toBeNull();
    expect(parseBands([])).toBeNull();
  });

  it("takes each band's discount from the list band its first quantity falls in", () => {
    // List: 1+ −10%, 5+ −15%, 10+ −20%.
    expect(tiersForBands(DEFAULT_TIERS, [1, 2, 6])).toEqual([
      { minQty: 1, discountPct: 10 },
      { minQty: 2, discountPct: 10 },
      { minQty: 6, discountPct: 15 },
    ]);
    expect(tiersForBands(DEFAULT_TIERS, null)).toBe(DEFAULT_TIERS);
  });

  it("labels and prices the product's bands, not the list's", () => {
    const tiers = tiersForBands(DEFAULT_TIERS, [1, 2, 6]);
    const p = priceVariant({ cost: 600, retail: 1000, overrides: { 2: 870 } }, { ...settings, tiers });
    expect(p.tiers.map((t) => [t.label, t.price])).toEqual([
      ["1 pc", 900],
      ["2–5 pcs", 870],
      ["6+ pcs", 850],
    ]);
  });
});

describe("parseOverrides", () => {
  it("keeps real prices keyed by band and ignores blanks", () => {
    expect(parseOverrides({ "1": 900, "5": "", "10": null, x: 4, "20": "780.5" })).toEqual({ 1: 900, 20: 780.5 });
    expect(parseOverrides(null)).toEqual({});
  });
});

describe("roundUpTo", () => {
  it("rounds up, never down, so rounding can't eat margin", () => {
    expect(roundUpTo(851, 5)).toBe(855);
    expect(roundUpTo(850, 5)).toBe(850);
    expect(roundUpTo(850.0000001, 5)).toBe(850);
    expect(roundUpTo(851.4, 1)).toBe(852);
    expect(roundUpTo(851.4, 0)).toBe(851.4);
  });
});

describe("priceVariant", () => {
  it("takes each band's discount off retail", () => {
    const p = priceVariant({ cost: 600, retail: 1000 }, settings);
    expect(p.tiers.map((t) => t.price)).toEqual([900, 850, 800]);
    expect(p.tiers[0]).toMatchObject({ profit: 300, marginPct: 50, resellerGain: 100, manual: false });
    expect(p.floor).toBe(660);
    expect(p.bandsOutOfOrder).toBe(false);
  });

  it("never lets a calculated price fall under cost plus the minimum margin", () => {
    // 20% off 500 is 400, but cost 380 + 10% = 418 → rounded up to 420.
    const p = priceVariant({ cost: 380, retail: 500 }, settings);
    expect(p.tiers.map((t) => t.price)).toEqual([450, 425, 420]);
    expect(p.tiers[2].raisedToFloor).toBe(true);
    expect(p.tiers[1].raisedToFloor).toBe(false);
  });

  it("does not round a floor past the retail price", () => {
    // Floor 99 rounds up to 100, but retail is 99: hold at retail.
    const p = priceVariant({ cost: 90, retail: 99 }, settings);
    expect(p.tiers.every((t) => t.price <= 99)).toBe(true);
  });

  it("takes a hand-set price as given but flags one under the floor", () => {
    const p = priceVariant({ cost: 600, retail: 1000, overrides: { 1: 950, 10: 640 } }, settings);
    expect(p.tiers[0]).toMatchObject({ price: 950, manual: true, belowFloor: false });
    expect(p.tiers[2]).toMatchObject({ price: 640, manual: true, belowFloor: true, profit: 40 });
  });

  it("flags a bigger band that costs more per piece", () => {
    const p = priceVariant({ cost: 600, retail: 1000, overrides: { 5: 950 } }, settings);
    expect(p.bandsOutOfOrder).toBe(true);
  });

  it("still prices a variant nobody has costed, without a floor", () => {
    const p = priceVariant({ cost: null, retail: 1000 }, settings);
    expect(p.floor).toBeNull();
    expect(p.tiers[0]).toMatchObject({ price: 900, profit: null, marginPct: null });
  });
});

describe("resellerRow", () => {
  it("carries prices and retail only — nothing about cost or profit", () => {
    const priced = priceVariant({ cost: 600, retail: 1000 }, settings);
    const row = resellerRow(
      { key: "v1", product: "Teether", variant: "Blue", sku: null, category: "Toys" },
      priced,
    );
    expect(row).toEqual({
      key: "v1",
      product: "Teether",
      variant: "Blue",
      sku: "",
      category: "Toys",
      retail: 1000,
      bands: [
        { label: "1–4 pcs", price: 900 },
        { label: "5–9 pcs", price: 850 },
        { label: "10+ pcs", price: 800 },
      ],
    });
    expect(bandLines(row, (v) => `৳${v}`)).toEqual(["1–4 pcs: ৳900", "5–9 pcs: ৳850", "10+ pcs: ৳800"]);
    const text = JSON.stringify(row);
    expect(text).not.toContain("600");
    expect(text).not.toMatch(/cost|profit|margin/i);
  });

  it("sorts by category, product, variant with uncategorised last", () => {
    const base = { key: "", variant: "", sku: "", retail: 0, bands: [] };
    const rows = [
      { ...base, product: "B", category: "" },
      { ...base, product: "Z", category: "Bath" },
      { ...base, product: "A", category: "Toys" },
      { ...base, product: "A", category: "Bath" },
    ].sort(compareResellerRows);
    expect(rows.map((r) => `${r.category}/${r.product}`)).toEqual(["Bath/A", "Bath/Z", "Toys/A", "/B"]);
  });
});
