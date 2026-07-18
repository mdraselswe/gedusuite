"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { refreshInventoryAlerts } from "@/lib/inventory";

export type ActionResult = { ok: true } | { ok: false; error: string };

const PurchaseSchema = z.object({
  productVariantId: z.string().min(1, "Select a product variant"),
  supplierId: z.string().optional().or(z.literal("")),
  date: z.coerce.date(),
  unitCost: z.coerce.number().nonnegative("Unit cost must be ≥ 0"),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  expiryDate: z.string().optional().or(z.literal("")),
});

export async function createPurchase(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "purchases", "add");
  if (!gate.ok) return gate;

  const parsed = PurchaseSchema.safeParse({
    productVariantId: formData.get("productVariantId"),
    supplierId: formData.get("supplierId") ?? undefined,
    date: formData.get("date"),
    unitCost: formData.get("unitCost"),
    quantity: formData.get("quantity"),
    expiryDate: formData.get("expiryDate") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const workspaceId = gate.access.workspaceId;

  // Validate the variant belongs to this workspace.
  const variant = await prisma.productVariant.findFirst({
    where: { id: d.productVariantId, product: { workspaceId } },
    select: { id: true },
  });
  if (!variant) return { ok: false, error: "Product variant not found" };

  // Validate supplier (if given) belongs to this workspace.
  let supplierId: string | null = null;
  if (d.supplierId) {
    const supplier = await prisma.supplier.findFirst({
      where: { id: d.supplierId, workspaceId },
      select: { id: true },
    });
    if (!supplier) return { ok: false, error: "Supplier not found" };
    supplierId = supplier.id;
  }

  await prisma.purchase.create({
    data: {
      workspaceId,
      productVariantId: d.productVariantId,
      supplierId,
      date: d.date,
      unitCost: d.unitCost,
      quantity: d.quantity,
      expiryDate: d.expiryDate ? new Date(d.expiryDate) : null,
    },
  });

  // Stock changed → recompute low-stock / expiry alerts.
  await refreshInventoryAlerts(workspaceId);

  revalidatePath(`/${slug}/purchases`);
  revalidatePath(`/${slug}/products`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deletePurchase(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "purchases", "edit");
  if (!gate.ok) return gate;

  await prisma.purchase.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  await refreshInventoryAlerts(gate.access.workspaceId);
  revalidatePath(`/${slug}/purchases`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
