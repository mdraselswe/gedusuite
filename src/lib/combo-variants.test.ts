import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { productVariant: { findMany } } }));
import { loadFlexibleComboVariants } from "@/lib/combo-variants";

const combo = { flexibleVariants: true, items: [{ productVariant: { productId: "spider" } }] };
const variant = (id: string) => ({
  id, productId: "spider", salePrice: 50, wooProductId: null,
  attributes: { Colour: id }, product: { name: "Spider Man", weightGrams: 10 },
});

describe("loading all current product colours", () => {
  beforeEach(() => findMany.mockReset());
  it("reads the product's variants within the workspace, including unlinked colours", async () => {
    findMany.mockResolvedValue([variant("yellow"), variant("red")]);
    const result = await loadFlexibleComboVariants("shop", [combo]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { productId: { in: ["spider"] }, product: { workspaceId: "shop" } } }));
    expect(result.map((v) => [v.productVariantId, v.quantity, v.wooProductId])).toEqual([["yellow", 0, null], ["red", 0, null]]);
  });
  it("reloads variants so a newly added colour appears without editing the recipe", async () => {
    findMany.mockResolvedValueOnce([variant("yellow")]).mockResolvedValueOnce([variant("yellow"), variant("green")]);
    expect(await loadFlexibleComboVariants("shop", [combo])).toHaveLength(1);
    expect(await loadFlexibleComboVariants("shop", [combo])).toHaveLength(2);
  });
  it("does not query alternatives for fixed combos", async () => {
    expect(await loadFlexibleComboVariants("shop", [{ ...combo, flexibleVariants: false }])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
