"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { refreshInventoryAlerts, variantStockMap } from "@/lib/inventory";
import { InsufficientTreasury, assertTreasuryCovers } from "@/lib/finance";
import { ConcurrentWrite, runSerializable } from "@/lib/tx";
import { removePartnerCredit, syncPartnerCredit } from "@/lib/partner-credit";
import { variantFullName } from "@/lib/variants";

export type ActionResult = { ok: true } | { ok: false; error: string };

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Funding touches three ledgers besides this list. Partners is revalidated as
 * a layout so the per-partner detail pages — where the derived credit shows —
 * are refreshed too, not just the list.
 */
function revalidateAll(slug: string) {
  revalidatePath(`/${slug}/purchases`);
  revalidatePath(`/${slug}/products`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/partners`, "layout");
  revalidatePath(`/${slug}/dashboard`);
}

const PurchaseSchema = z.object({
  productVariantId: z.string().min(1, "Select a product variant"),
  supplierId: z.string().optional().or(z.literal("")),
  // Funding source is one of four mutually exclusive states — driven by a
  // single field instead of trying to infer exclusivity from three raw ones.
  fundingSource: z.enum(["NONE", "PARTNER", "TREASURY", "CREDIT"]).default("NONE"),
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
      select: { id: true, attributes: true, product: { select: { name: true } } },
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
  // Nothing has been paid yet — no treasury deduction, no partner credit, and
  // a supplier due instead of consumed capital.
  const onCredit = d.fundingSource === "CREDIT";

  const cost = round2(d.unitCost * d.quantity);
  const label = variantFullName(variant.product.name, variant.attributes);

  try {
    await runSerializable(async (tx) => {
      // Serializable, so the balance can't be read and spent twice by two
      // people saving at the same moment — see runSerializable for why the
      // check being inside the transaction isn't enough on its own.
      if (paidFromTreasury) await assertTreasuryCovers(tx, workspaceId, cost);
    const purchase = await tx.purchase.create({
      data: {
        workspaceId,
        productVariantId: d.productVariantId,
        supplierId,
        paidByPartnerId,
        paidFromTreasury,
        onCredit,
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
    if (paidByPartnerId) {
      await syncPartnerCredit(tx, {
        workspaceId,
        link: { purchaseId: purchase.id },
        partnerId: paidByPartnerId,
        amount: cost,
        purpose: `Product purchase: ${label}`,
        date: d.date,
      });
    }
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  // Stock changed → recompute low-stock / expiry alerts.
  await refreshInventoryAlerts(workspaceId);

  revalidateAll(slug);
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
      select: { id: true, attributes: true, product: { select: { name: true } } },
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
  // Nothing has been paid yet — no treasury deduction, no partner credit, and
  // a supplier due instead of consumed capital.
  const onCredit = d.fundingSource === "CREDIT";
  const newCost = round2(d.unitCost * d.quantity);
  const wasTreasuryFunded = existing.paidFromTreasury;
  const oldEntryAmount = existing.treasuryEntry ? Number(existing.treasuryEntry.amount) : 0;

  // Becoming treasury-funded, or staying treasury-funded with a changed cost —
  // either way, check the balance can cover it. When it was already
  // treasury-funded, add back the old entry's amount first: that money is
  // being replaced, not spent a second time.
  const label = variantFullName(variant.product.name, variant.attributes);

  try {
    await runSerializable(async (tx) => {
      // The old entry's amount is credited back: it's being replaced, not spent
      // a second time.
      if (paidFromTreasury) {
        await assertTreasuryCovers(
          tx,
          workspaceId,
          newCost,
          wasTreasuryFunded ? oldEntryAmount : 0,
        );
      }
      await tx.purchase.update({
      where: { id },
      data: {
        productVariantId: d.productVariantId,
        supplierId: supplier?.id ?? null,
        paidByPartnerId,
        paidFromTreasury,
        onCredit,
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

    // Unconditional: this one call covers becoming partner-funded, ceasing to
    // be, switching partner, and a plain cost change.
    await syncPartnerCredit(tx, {
      workspaceId,
      link: { purchaseId: id },
      partnerId: paidByPartnerId,
      amount: newCost,
      purpose: `Product purchase: ${label}`,
      date: d.date,
    });
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  // Cost/quantity/variant may have changed → stock and alerts must recompute.
  await refreshInventoryAlerts(workspaceId);

  revalidateAll(slug);
  return { ok: true };
}

/**
 * Remove a purchase, unless the stock it brought in has already been sold.
 *
 * Stock is derived — purchased minus sold plus returns — so deleting a lot
 * whose pieces have left the shelf doesn't fail anywhere: the variant simply
 * goes to a negative quantity, which is not a thing a shelf can do. Worse, the
 * cost snapshot for the NEXT sale is read from the latest purchase, so removing
 * one quietly re-prices every future sale of that variant against an older
 * figure, or against nothing at all.
 *
 * Blocked rather than corrected, in the same spirit as the finance deletes: a
 * purchase that has been sold out of is a fact, and the fix for a wrong one is
 * to edit its cost or quantity, not to make the goods retrospectively never
 * have arrived.
 */
export async function deletePurchase(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "purchases", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const existing = await prisma.purchase.findFirst({
    where: { id, workspaceId },
    select: {
      quantity: true,
      productVariantId: true,
      productVariant: {
        select: { attributes: true, product: { select: { name: true } } },
      },
    },
  });
  if (!existing) return { ok: true };

  const stock = await variantStockMap(workspaceId, [existing.productVariantId]);
  const onHand = stock.get(existing.productVariantId) ?? 0;
  if (onHand < existing.quantity) {
    const label = variantFullName(
      existing.productVariant.product.name,
      existing.productVariant.attributes,
    );
    return {
      ok: false,
      error:
        `${existing.quantity} piece(s) of ${label} came in on this purchase but only ${onHand} ` +
        `are still on the shelf — deleting it would leave the stock negative and change the ` +
        `cost of future sales. Edit the purchase instead, or record a stock adjustment.`,
    };
  }

  await prisma.$transaction(async (tx) => {
    // Delete the linked treasury deduction first, if any — the FK is
    // ON DELETE SET NULL, which would otherwise leave a stray entry behind
    // still counting against the treasury balance for a purchase that no
    // longer exists.
    await tx.treasuryEntry.deleteMany({ where: { workspaceId, purchaseId: id } });
    await removePartnerCredit(tx, workspaceId, { purchaseId: id });
    await tx.purchase.deleteMany({ where: { id, workspaceId } });
  });

  await refreshInventoryAlerts(workspaceId);
  revalidateAll(slug);
  return { ok: true };
}
