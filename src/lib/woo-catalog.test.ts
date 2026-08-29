import { describe, expect, it } from "vitest";
import { searchCatalog, suggestMatch, type WooCatalogEntry } from "@/lib/woo-catalog";

const entry = (over: Partial<WooCatalogEntry> & { id: number; label: string }): WooCatalogEntry => ({
  sku: null,
  parentId: null,
  managesStock: true,
  stock: 5,
  ...over,
});

const catalogue: WooCatalogEntry[] = [
  entry({ id: 101, label: "Robotic Aeroplane Toy", sku: "AERO-1" }),
  entry({ id: 102, label: "Silicone Baby Feeding Bottle — Pink", parentId: 100 }),
  entry({ id: 103, label: "Silicone Baby Feeding Bottle — Blue", parentId: 100 }),
  entry({ id: 104, label: "AA Battery Pack", sku: "batt aa", managesStock: false, stock: null }),
  entry({ id: 105, label: "Wooden Spelling Blocks" }),
  entry({ id: 106, label: "Wooden Spelling Blocks" }),
];

describe("searchCatalog", () => {
  it("returns the head of the list for an empty query", () => {
    expect(searchCatalog(catalogue, "", 3).map((e) => e.id)).toEqual([101, 102, 103]);
  });

  it("ignores case and punctuation", () => {
    const hits = searchCatalog(catalogue, "SILICONE, baby!");
    expect(hits.map((e) => e.id)).toEqual([102, 103]);
  });

  it("requires every term, so extra words narrow rather than widen", () => {
    expect(searchCatalog(catalogue, "bottle pink").map((e) => e.id)).toEqual([102]);
    expect(searchCatalog(catalogue, "bottle green")).toEqual([]);
  });

  it("matches on SKU as well as name", () => {
    expect(searchCatalog(catalogue, "aero-1").map((e) => e.id)).toEqual([101]);
  });

  it("honours the limit", () => {
    expect(searchCatalog(catalogue, "silicone", 1)).toHaveLength(1);
  });
});

describe("suggestMatch", () => {
  it("prefers the SKU, punctuation and case aside", () => {
    const hit = suggestMatch(catalogue, { sku: "Batt-AA", label: "Something else entirely" });
    expect(hit?.id).toBe(104);
  });

  it("falls back to an exact name when there is no SKU", () => {
    const hit = suggestMatch(catalogue, { sku: null, label: "robotic aeroplane toy" });
    expect(hit?.id).toBe(101);
  });

  it("refuses to guess when two products share a name", () => {
    // Two right answers is the case where a wrong link would be silent: the
    // recipe would look complete and sell the wrong shelf.
    expect(suggestMatch(catalogue, { sku: null, label: "Wooden Spelling Blocks" })).toBeNull();
  });

  it("returns null rather than a near miss", () => {
    expect(suggestMatch(catalogue, { sku: null, label: "Robotic Aeroplane" })).toBeNull();
  });

  it("does not match a SKU against a name", () => {
    expect(suggestMatch(catalogue, { sku: "Robotic Aeroplane Toy", label: "no such thing" })).toBeNull();
  });
});
