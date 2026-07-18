"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { refreshInventoryAlerts } from "@/lib/inventory";

export type ActionResult = { ok: true } | { ok: false; error: string };

const Schema = z.object({
  productVariantId: z.string().min(1, "Select a product variant"),
  type: z.enum(["DAMAGED", "LOST", "GIFT", "CORRECTION"]),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  direction: z.enum(["ADD", "REMOVE"]).default("REMOVE"),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
  date: z.coerce.date(),
});

export async function createStockAdjustment(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = Schema.safeParse({
    productVariantId: formData.get("productVariantId"),
    type: formData.get("type"),
    quantity: formData.get("quantity"),
    direction: formData.get("direction") ?? "REMOVE",
    reason: formData.get("reason") ?? undefined,
    date: formData.get("date"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  const variant = await prisma.productVariant.findFirst({
    where: { id: d.productVariantId, product: { workspaceId } },
    select: { id: true },
  });
  if (!variant) return { ok: false, error: "Product variant not found" };

  // Damaged / lost / gift always remove stock; correction can go either way.
  const removes = d.type !== "CORRECTION" || d.direction === "REMOVE";
  const delta = removes ? -d.quantity : d.quantity;

  await prisma.stockAdjustment.create({
    data: {
      workspaceId,
      productVariantId: d.productVariantId,
      type: d.type,
      delta,
      reason: d.reason?.trim() || null,
      date: d.date,
    },
  });

  await refreshInventoryAlerts(workspaceId);
  revalidatePath(`/${slug}/products`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deleteStockAdjustment(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "products", "edit");
  if (!gate.ok) return gate;
  await prisma.stockAdjustment.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  await refreshInventoryAlerts(gate.access.workspaceId);
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}
