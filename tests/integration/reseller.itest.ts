import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadResellerList } from "@/lib/reseller-list";
import { saveResellerSettings, saveVariantResellerPrice, syncResellerNow } from "@/server/actions/reseller";
import { actAs, addMember, createUser, createWorkspaceWithOwner, resetDatabase } from "./harness";

let owner = "";
let staff = "";
let ws = "";
let teether = "";
let blanket = "";
let unpriced = "";

beforeAll(async () => {
  await resetDatabase();
  const o = await createUser("owner@rs.test", "Owner");
  const s = await createUser("staff@rs.test", "Staff");
  const w = await createWorkspaceWithOwner("Gedu Test", "gedu-test", o.id);
  await addMember(w.id, s.id, "STAFF");
  owner = o.id;
  staff = s.id;
  ws = w.id;

  const product = (name: string, category: string | null, salePrice: number | null, unitCost: number | null) =>
    prisma.product.create({
      data: { workspaceId: ws, name, category, variants: { create: [{ salePrice, unitCost }] } },
      include: { variants: true },
    });
  teether = (await product("টিদার", "Toys", 1000, 600)).variants[0].id;
  blanket = (await product("Blanket", "Bedding", 500, 380)).variants[0].id;
  unpriced = (await product("Sample", null, null, 50)).variants[0].id;
});

describe("reseller price list", () => {
  it("prices every band from retail, held above cost plus the minimum margin", async () => {
    const { rows, resellerRows, tierLabels } = await loadResellerList(ws);
    // Defaults: one piece −5%, 2–5 −15%, 6+ −20%.
    expect(tierLabels).toEqual(["1 pc", "2–5 pcs", "6+ pcs"]);
    const t = rows.find((r) => r.variantId === teether)!;
    expect(t.priced!.tiers.map((x) => x.price)).toEqual([950, 850, 800]);
    const b = rows.find((r) => r.variantId === blanket)!;
    // 20% off 500 = 400 is under 380 + 10%; held at 420.
    expect(b.priced!.tiers[2]).toMatchObject({ price: 420, raisedToFloor: true });
    // No retail price, so nothing to offer.
    expect(resellerRows.map((r) => r.key)).not.toContain(unpriced);
    expect(resellerRows.map((r) => r.product)).toEqual(["Blanket", "টিদার"]);
  });

  it("what leaves the app carries no cost or profit", async () => {
    const { resellerRows } = await loadResellerList(ws);
    for (const r of resellerRows) {
      expect(Object.keys(r).sort()).toEqual(["bands", "category", "key", "product", "retail", "sku", "variant"]);
      for (const b of r.bands) expect(Object.keys(b).sort()).toEqual(["label", "price"]);
    }
  });

  it("staff can't see or change reseller pricing", async () => {
    await actAs(staff);
    const res = await saveResellerSettings("gedu-test", {
      title: "x",
      minMarginPct: 0,
      roundTo: 1,
      tiers: [{ minQty: 1, discountPct: 50 }],
    });
    expect(res.ok).toBe(false);
    expect((await saveVariantResellerPrice("gedu-test", teether, { hidden: true, prices: {} })).ok).toBe(false);
  });

  it("the owner sets bands, hand-sets a price and hides a product", async () => {
    await actAs(owner);
    const set = await saveResellerSettings("gedu-test", {
      title: "Reseller list",
      notes: "Sell at retail or above.",
      minMarginPct: 10,
      roundTo: 10,
      tiers: [
        { minQty: 1, discountPct: 10 },
        { minQty: 6, discountPct: 20 },
      ],
    });
    expect(set.ok).toBe(true);
    expect(
      (await saveVariantResellerPrice("gedu-test", teether, { hidden: false, prices: { "6": 790, "1": null } })).ok,
    ).toBe(true);

    let list = await loadResellerList(ws);
    expect(list.tierLabels).toEqual(["1–5 pcs", "6+ pcs"]);
    const t = list.rows.find((r) => r.variantId === teether)!;
    expect(t.priced!.tiers.map((x) => [x.price, x.manual])).toEqual([
      [900, false],
      [790, true],
    ]);
    expect(t.autoPrices).toEqual([900, 800]);

    await saveVariantResellerPrice("gedu-test", blanket, { hidden: true, prices: {} });
    list = await loadResellerList(ws);
    expect(list.resellerRows.map((r) => r.key)).toEqual([teether]);

    const history = await prisma.activityLog.count({ where: { workspaceId: ws, entity: { startsWith: "Reseller" } } });
    expect(history).toBe(3);
  });

  it("one product gets its own bands while the rest keep the list's", async () => {
    await actAs(owner);
    const res = await saveVariantResellerPrice("gedu-test", teether, {
      hidden: false,
      bands: [1, 2, 6],
      // 6 is a band of the old list too; "9" is in neither and is dropped.
      prices: { "2": 860, "9": 700 },
    });
    expect(res.ok).toBe(true);
    const list = await loadResellerList(ws);
    const t = list.rows.find((r) => r.variantId === teether)!;
    expect(t.customBands).toEqual([1, 2, 6]);
    expect(t.overrides).toEqual({ 2: 860 });
    expect(t.priced!.tiers.map((x) => [x.label, x.price, x.manual])).toEqual([
      ["1 pc", 900, false],
      ["2–5 pcs", 860, true],
      ["6+ pcs", 800, false],
    ]);
    expect(list.resellerRows.find((r) => r.key === teether)!.bands.map((b) => b.label)).toEqual([
      "1 pc",
      "2–5 pcs",
      "6+ pcs",
    ]);

    // Back to the list's bands.
    expect((await saveVariantResellerPrice("gedu-test", teether, { hidden: false, bands: null, prices: {} })).ok).toBe(true);
    const again = (await loadResellerList(ws)).rows.find((r) => r.variantId === teether)!;
    expect(again.customBands).toBeNull();
    expect(again.priced!.tiers.map((x) => x.label)).toEqual(["1–5 pcs", "6+ pcs"]);
  });

  it("refuses two bands starting at the same quantity", async () => {
    await actAs(owner);
    const res = await saveVariantResellerPrice("gedu-test", teether, { hidden: false, bands: [1, 3, 3], prices: {} });
    expect(res).toMatchObject({ ok: false });
  });

  it("refuses another shop's variant", async () => {
    const o2 = await createUser("other@rs.test", "Other");
    await createWorkspaceWithOwner("Other", "other-rs", o2.id);
    await actAs(o2.id);
    const res = await saveVariantResellerPrice("other-rs", teether, { hidden: true, prices: {} });
    expect(res).toMatchObject({ ok: false, error: "Variant not found" });
  });

  it("syncing without a Google account says so instead of failing silently", async () => {
    await actAs(owner);
    const res = await syncResellerNow("gedu-test");
    expect(res).toMatchObject({ ok: false });
  });
});
