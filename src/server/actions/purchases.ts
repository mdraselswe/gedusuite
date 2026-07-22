"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { refreshInventoryAlerts } from "@/lib/inventory";
import { treasuryBalance } from "@/lib/finance";

export type ActionResult = { ok: true } | { ok: false; error: string };

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

const PurchaseSchema = z.object({
  productVariantId: z.string().min(1, "Select a product variant"),
  supplierId: z.string().optional().or(z.literal("")),
  // Funding source is one of three mutually exclusive states — driven by a
  // single field instead of trying to infer exclusivity from two raw ones.
  fundingSource: z.enum(["NONE", "PARTNER", "TREASURY"]).default("NONE"),
  paidByPartnerId: z.string().optional().or(z.literal("")),
  date: z.coerce.date(),
  unitCost: z.coerce.number().nonnegative("Unit cost must be ≥ 0"),
  // Intended per-unit selling price — optional note, no effect on money math.
  salePrice: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative("Sale price must be ≥ 0").optional(),
  ),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  expiryDate: z.string().optional().or(z.literal("")),
});

export async function createPurchase(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "purchases", "add");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = PurchaseSchema.safeParse({
    productVariantId: formData.get("productVariantId"),
    supplierId: formData.get("supplierId") ?? undefined,
    fundingSource: formData.get("fundingSource") ?? "NONE",
    paidByPartnerId: formData.get("paidByPartnerId") ?? undefined,
    date: formData.get("date"),
    unitCost: formData.get("unitCost"),
    salePrice: formData.get("salePrice") ?? undefined,
    quantity: formData.get("quantity"),
    expiryDate: formData.get("expiryDate") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  if (d.fundingSource === "PARTNER" && !d.paidByPartnerId) {
    return { ok: false, error: "Select a partner" };
  }

  // Variant + supplier + partner checks are independent — run concurrently
  // instead of one after another (each round trip costs real time over a
  // remote DB).
  const [variant, supplier, partner] = await Promise.all([
    prisma.productVariant.findFirst({
      where: { id: d.productVariantId, product: { workspaceId } },
      select: { id: true, size: true, color: true, product: { select: { name: true } } },
    }),
    d.supplierId
      ? prisma.supplier.findFirst({ where: { id: d.supplierId, workspaceId }, select: { id: true } })
      : Promise.resolve(null),
    d.fundingSource === "PARTNER" && d.paidByPartnerId
      ? prisma.partner.findFirst({ where: { id: d.paidByPartnerId, workspaceId }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (!variant) return { ok: false, error: "Product variant not found" };
  if (d.supplierId && !supplier) return { ok: false, error: "Supplier not found" };
  if (d.fundingSource === "PARTNER" && !partner) return { ok: false, error: "Partner not found" };
  const supplierId = supplier?.id ?? null;
  const paidByPartnerId = d.fundingSource === "PARTNER" ? (partner?.id ?? null) : null;
  const paidFromTreasury = d.fundingSource === "TREASURY";

  const cost = round2(d.unitCost * d.quantity);
  if (paidFromTreasury) {
    const balance = await treasuryBalance(workspaceId);
    if (balance < cost) {
      return {
        ok: false,
        error: `Treasury balance is insufficient — available ${balance.toFixed(2)}, need ${cost.toFixed(2)}`,
      };
    }
  }

  const extra = [variant.size, variant.color].filter(Boolean).join(" / ");
  const label = variant.product.name + (extra ? ` (${extra})` : "");

  await prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.create({
      data: {
        workspaceId,
        productVariantId: d.productVariantId,
        supplierId,
        paidByPartnerId,
        paidFromTreasury,
        date: d.date,
        unitCost: d.unitCost,
        salePrice: d.salePrice ?? null,
        quantity: d.quantity,
        expiryDate: d.expiryDate ? new Date(d.expiryDate) : null,
      },
    });
    if (paidFromTreasury) {
      await tx.treasuryEntry.create({
        data: {
          workspaceId,
          type: "OUT",
          amount: cost,
          source: `Product purchase: ${label}`,
          purchaseId: purchase.id,
          date: d.date,
        },
      });
    }
  });

  // Stock changed → recompute low-stock / expiry alerts.
  await refreshInventoryAlerts(workspaceId);

  revalidatePath(`/${slug}/purchases`);
  revalidatePath(`/${slug}/products`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function updatePurchase(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "purchases", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = PurchaseSchema.safeParse({
    productVariantId: formData.get("productVariantId"),
    supplierId: formData.get("supplierId") ?? undefined,
    fundingSource: formData.get("fundingSource") ?? "NONE",
    paidByPartnerId: formData.get("paidByPartnerId") ?? undefined,
    date: formData.get("date"),
    unitCost: formData.get("unitCost"),
    salePrice: formData.get("salePrice") ?? undefined,
    quantity: formData.get("quantity"),
    expiryDate: formData.get("expiryDate") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  if (d.fundingSource === "PARTNER" && !d.paidByPartnerId) {
    return { ok: false, error: "Select a partner" };
  }

  const [existing, variant, supplier, partner] = await Promise.all([
    prisma.purchase.findFirst({
      where: { id, workspaceId },
      include: { treasuryEntry: { select: { id: true, amount: true } } },
    }),
    prisma.productVariant.findFirst({
      where: { id: d.productVariantId, product: { workspaceId } },
      select: { id: true, size: true, color: true, product: { select: { name: true } } },
    }),
    d.supplierId
      ? prisma.supplier.findFirst({ where: { id: d.supplierId, workspaceId }, select: { id: true } })
      : Promise.resolve(null),
    d.fundingSource === "PARTNER" && d.paidByPartnerId
      ? prisma.partner.findFirst({ where: { id: d.paidByPartnerId, workspaceId }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (!existing) return { ok: false, error: "Purchase not found" };
  if (!variant) return { ok: false, error: "Product variant not found" };
  if (d.supplierId && !supplier) return { ok: false, error: "Supplier not found" };
  if (d.fundingSource === "PARTNER" && !partner) return { ok: false, error: "Partner not found" };

  const paidByPartnerId = d.fundingSource === "PARTNER" ? (partner?.id ?? null) : null;
  const paidFromTreasury = d.fundingSource === "TREASURY";
  const newCost = round2(d.unitCost * d.quantity);
  const wasTreasuryFunded = existing.paidFromTreasury;
  const oldEntryAmount = existing.treasuryEntry ? Number(existing.treasuryEntry.amount) : 0;

  // Becoming treasury-funded, or staying treasury-funded with a changed cost —
  // either way, check the balance can cover it. When it was already
  // treasury-funded, add back the old entry's amount first: that money is
  // being replaced, not spent a second time.
  if (paidFromTreasury) {
    const balance = await treasuryBalance(workspaceId);
    const available = wasTreasuryFunded ? balance + oldEntryAmount : balance;
    if (available < newCost) {
      return {
        ok: false,
        error: `Treasury balance is insufficient — available ${available.toFixed(2)}, need ${newCost.toFixed(2)}`,
      };
    }
  }

  const extra = [variant.size, variant.color].filter(Boolean).join(" / ");
  const label = variant.product.name + (extra ? ` (${extra})` : "");

  await prisma.$transaction(async (tx) => {
    await tx.purchase.update({
      where: { id },
      data: {
        productVariantId: d.productVariantId,
        supplierId: supplier?.id ?? null,
        paidByPartnerId,
        paidFromTreasury,
        date: d.date,
        unitCost: d.unitCost,
        salePrice: d.salePrice ?? null,
        quantity: d.quantity,
        expiryDate: d.expiryDate ? new Date(d.expiryDate) : null,
      },
    });

    if (wasTreasuryFunded && !paidFromTreasury) {
      // No longer treasury-funded — remove the linked deduction entirely.
      await tx.treasuryEntry.deleteMany({ where: { purchaseId: id } });
    } else if (!wasTreasuryFunded && paidFromTreasury) {
      // Newly treasury-funded — create the linked deduction.
      await tx.treasuryEntry.create({
        data: {
          workspaceId,
          type: "OUT",
          amount: newCost,
          source: `Product purchase: ${label}`,
          purchaseId: id,
          date: d.date,
        },
      });
    } else if (wasTreasuryFunded && paidFromTreasury && existing.treasuryEntry) {
      // Still treasury-funded — keep the linked entry in sync with the new cost.
      await tx.treasuryEntry.update({
        where: { id: existing.treasuryEntry.id },
        data: { amount: newCost, source: `Product purchase: ${label}`, date: d.date },
      });
    }
  });

  // Cost/quantity/variant may have changed → stock and alerts must recompute.
  await refreshInventoryAlerts(workspaceId);

  revalidatePath(`/${slug}/purchases`);
  revalidatePath(`/${slug}/products`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deletePurchase(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "purchases", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  await prisma.$transaction(async (tx) => {
    // Delete the linked treasury deduction first, if any — the FK is
    // ON DELETE SET NULL, which would otherwise leave a stray entry behind
    // still counting against the treasury balance for a purchase that no
    // longer exists.
    await tx.treasuryEntry.deleteMany({ where: { workspaceId, purchaseId: id } });
    await tx.purchase.deleteMany({ where: { id, workspaceId } });
  });

  await refreshInventoryAlerts(workspaceId);
  revalidatePath(`/${slug}/purchases`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
