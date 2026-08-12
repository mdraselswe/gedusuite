"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { refreshInventoryAlerts } from "@/lib/inventory";
import { failed, type ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";
import { variantFullName } from "@/lib/variants";
import { dhakaDateField } from "@/lib/date-field";

export type ActionResult = { ok: true } | ActionFailure;

const Schema = z.object({
  productVariantId: z.string().min(1, "Select a product variant"),
  type: z.enum(["DAMAGED", "LOST", "GIFT", "CORRECTION"]),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  direction: z.enum(["ADD", "REMOVE"]).default("REMOVE"),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
  date: dhakaDateField,
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
    return failed(parsed.error);
  }
  const d = parsed.data;

  const variant = await prisma.productVariant.findFirst({
    where: { id: d.productVariantId, product: { workspaceId } },
    select: {
      id: true,
      attributes: true,
      product: { select: { name: true } },
    },
  });
  if (!variant) return { ok: false, error: "Product variant not found" };

  // Damaged / lost / gift always remove stock; correction can go either way.
  const removes = d.type !== "CORRECTION" || d.direction === "REMOVE";
  const delta = removes ? -d.quantity : d.quantity;

  const adjustment = await prisma.stockAdjustment.create({
    data: {
      workspaceId,
      productVariantId: d.productVariantId,
      type: d.type,
      delta,
      reason: d.reason?.trim() || null,
      date: d.date.at,
      dateHasTime: d.date.hasTime,
    },
  });

  await refreshInventoryAlerts(workspaceId);

  // Stock that leaves without a sale is the kind of movement somebody
  // eventually asks about, and "damaged" with no name against it is where the
  // asking starts.
  const variantLabel = variantFullName(variant.product.name, variant.attributes);
  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "StockAdjustment",
    entityId: adjustment.id,
    entityLabel: variantLabel,
    summary:
      `${d.type.toLowerCase()}: ${delta > 0 ? "+" : ""}${delta} × ${variantLabel}` +
      (d.reason?.trim() ? ` — ${d.reason.trim()}` : ""),
  });

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
  const existing = await prisma.stockAdjustment.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: {
      type: true,
      delta: true,
      productVariant: { select: { attributes: true, product: { select: { name: true } } } },
    },
  });
  await prisma.stockAdjustment.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  await refreshInventoryAlerts(gate.access.workspaceId);
  if (existing) {
    // Deleting one puts the stock back, so it moves the shelf as surely as
    // making one did.
    await recordActivity(gate.access, {
      action: "DELETE",
      entity: "StockAdjustment",
      entityId: id,
      entityLabel: variantFullName(
        existing.productVariant.product.name,
        existing.productVariant.attributes,
      ),
      summary: `Removed a ${existing.type.toLowerCase()} adjustment of ${existing.delta} — the stock went back`,
    });
  }
  revalidatePath(`/${slug}/products`);
  return { ok: true };
}
