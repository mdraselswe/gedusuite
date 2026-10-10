import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { variantStockMap } from "@/lib/inventory";
import { createProduct } from "@/server/actions/products";
import { createPurchase } from "@/server/actions/purchases";
import { createOrder } from "@/server/actions/orders";
import { actAs, addMember, createUser, createWorkspaceWithOwner, fd, resetDatabase } from "./harness";

describe("harness smoke: real actions against the local database", () => {
  let wsId = "";
  let variantId = "";

  beforeAll(async () => {
    await resetDatabase();
    const owner = await createUser("owner@test.local", "Owner");
    const ws = await createWorkspaceWithOwner("Smoke Shop", "smoke", owner.id);
    wsId = ws.id;
    await actAs(owner.id);
  });

  it("creates a product, buys stock, sells some", async () => {
    const created = await createProduct(
      "smoke",
      fd({
        name: "Test Toy",
        lowStockThreshold: 2,
        variants: [{ attributes: [], salePrice: 500, unitCost: 300 }],
      }),
    );
    expect(created).toEqual({ ok: true });
    const v = await prisma.productVariant.findFirstOrThrow({ where: { product: { workspaceId: wsId } } });
    variantId = v.id;

    const bought = await createPurchase(
      "smoke",
      fd({ productVariantId: variantId, date: "2026-09-01", unitCost: 300, quantity: 10 }),
    );
    expect(bought).toEqual({ ok: true });
    expect((await variantStockMap(wsId)).get(variantId)).toBe(10);

    const sold = await createOrder(
      "smoke",
      fd({
        date: "2026-09-02",
        status: "CONFIRMED",
        deliveryType: "SELF",
        paymentMethod: "CASH",
        paymentStatus: "UNPAID",
        items: [{ productVariantId: variantId, quantity: 3, unitPrice: 500, discount: 0 }],
      }),
    );
    expect(sold.ok).toBe(true);
    expect((await variantStockMap(wsId)).get(variantId)).toBe(7);
  });

  it("refuses overselling", async () => {
    const res = await createOrder(
      "smoke",
      fd({
        date: "2026-09-03",
        status: "CONFIRMED",
        deliveryType: "SELF",
        paymentMethod: "CASH",
        paymentStatus: "UNPAID",
        items: [{ productVariantId: variantId, quantity: 99, unitPrice: 500, discount: 0 }],
      }),
    );
    expect(res.ok).toBe(false);
  });

  it("isolates tenants: another workspace's owner cannot act on this one", async () => {
    const other = await createUser("other@test.local", "Other");
    await createWorkspaceWithOwner("Other Shop", "other", other.id);
    await actAs(other.id);
    const res = await createOrder(
      "smoke",
      fd({
        date: "2026-09-03",
        status: "CONFIRMED",
        deliveryType: "SELF",
        paymentMethod: "CASH",
        paymentStatus: "UNPAID",
        items: [{ productVariantId: variantId, quantity: 1, unitPrice: 500, discount: 0 }],
      }),
    );
    expect(res.ok).toBe(false);
    void addMember;
  });
});
