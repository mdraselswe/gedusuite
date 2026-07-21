"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { treasuryBalance } from "@/lib/finance";

export type ActionResult = { ok: true } | { ok: false; error: string };

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

const CATEGORIES = [
  "OFFICE_SUPPLIES",
  "PACKAGING_MATERIAL",
  "EQUIPMENT",
  "UTILITIES",
  "OTHER",
] as const;

const Schema = z.object({
  itemName: z.string().trim().min(1, "Item name is required").max(160),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  supplierName: z.string().trim().max(160).optional().or(z.literal("")),
  // Funding source is one of three mutually exclusive states — driven by a
  // single field instead of trying to infer exclusivity from two raw ones.
  fundingSource: z.enum(["NONE", "PARTNER", "TREASURY"]).default("NONE"),
  paidByPartnerId: z.string().optional().or(z.literal("")),
  cost: z.coerce.number().nonnegative("Cost must be ≥ 0"),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  category: z.enum(CATEGORIES),
  date: z.coerce.date(),
});

function parse(formData: FormData) {
  return Schema.safeParse({
    itemName: formData.get("itemName"),
    description: formData.get("description") ?? undefined,
    supplierName: formData.get("supplierName") ?? undefined,
    fundingSource: formData.get("fundingSource") ?? "NONE",
    paidByPartnerId: formData.get("paidByPartnerId") ?? undefined,
    cost: formData.get("cost"),
    quantity: formData.get("quantity"),
    category: formData.get("category"),
    date: formData.get("date"),
  });
}

const clean = (s?: string) => (s && s.trim() ? s.trim() : null);
const MODULE = "internal-purchases" as const;

export async function createInternalPurchase(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "add");
  if (!gate.ok) return gate;
  const parsed = parse(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const workspaceId = gate.access.workspaceId;

  if (d.fundingSource === "PARTNER" && !d.paidByPartnerId) {
    return { ok: false, error: "Select a partner" };
  }

  let paidByPartnerId: string | null = null;
  if (d.fundingSource === "PARTNER" && d.paidByPartnerId) {
    const partner = await prisma.partner.findFirst({
      where: { id: d.paidByPartnerId, workspaceId },
      select: { id: true },
    });
    if (!partner) return { ok: false, error: "Partner not found" };
    paidByPartnerId = partner.id;
  }
  const paidFromTreasury = d.fundingSource === "TREASURY";

  const cost = round2(d.cost * d.quantity);
  if (paidFromTreasury) {
    const balance = await treasuryBalance(workspaceId);
    if (balance < cost) {
      return {
        ok: false,
        error: `Treasury balance is insufficient — available ${balance.toFixed(2)}, need ${cost.toFixed(2)}`,
      };
    }
  }

  await prisma.$transaction(async (tx) => {
    const item = await tx.internalPurchase.create({
      data: {
        workspaceId,
        itemName: d.itemName,
        description: clean(d.description),
        supplierName: clean(d.supplierName),
        paidByPartnerId,
        paidFromTreasury,
        cost: d.cost,
        quantity: d.quantity,
        category: d.category,
        date: d.date,
      },
    });
    if (paidFromTreasury) {
      await tx.treasuryEntry.create({
        data: {
          workspaceId,
          type: "OUT",
          amount: cost,
          source: `Internal purchase: ${d.itemName}`,
          internalPurchaseId: item.id,
          date: d.date,
        },
      });
    }
  });

  revalidatePath(`/${slug}/internal-purchases`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function updateInternalPurchase(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const parsed = parse(formData);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const workspaceId = gate.access.workspaceId;

  if (d.fundingSource === "PARTNER" && !d.paidByPartnerId) {
    return { ok: false, error: "Select a partner" };
  }

  const existing = await prisma.internalPurchase.findFirst({
    where: { id, workspaceId },
    include: { treasuryEntry: { select: { id: true, amount: true } } },
  });
  if (!existing) return { ok: false, error: "Entry not found" };

  let paidByPartnerId: string | null = null;
  if (d.fundingSource === "PARTNER" && d.paidByPartnerId) {
    const partner = await prisma.partner.findFirst({
      where: { id: d.paidByPartnerId, workspaceId },
      select: { id: true },
    });
    if (!partner) return { ok: false, error: "Partner not found" };
    paidByPartnerId = partner.id;
  }
  const paidFromTreasury = d.fundingSource === "TREASURY";
  const newCost = round2(d.cost * d.quantity);
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

  await prisma.$transaction(async (tx) => {
    await tx.internalPurchase.update({
      where: { id },
      data: {
        itemName: d.itemName,
        description: clean(d.description),
        supplierName: clean(d.supplierName),
        paidByPartnerId,
        paidFromTreasury,
        cost: d.cost,
        quantity: d.quantity,
        category: d.category,
        date: d.date,
      },
    });

    if (wasTreasuryFunded && !paidFromTreasury) {
      // No longer treasury-funded — remove the linked deduction entirely.
      await tx.treasuryEntry.deleteMany({ where: { internalPurchaseId: id } });
    } else if (!wasTreasuryFunded && paidFromTreasury) {
      // Newly treasury-funded — create the linked deduction.
      await tx.treasuryEntry.create({
        data: {
          workspaceId,
          type: "OUT",
          amount: newCost,
          source: `Internal purchase: ${d.itemName}`,
          internalPurchaseId: id,
          date: d.date,
        },
      });
    } else if (wasTreasuryFunded && paidFromTreasury && existing.treasuryEntry) {
      // Still treasury-funded — keep the linked entry in sync with the new cost.
      await tx.treasuryEntry.update({
        where: { id: existing.treasuryEntry.id },
        data: { amount: newCost, source: `Internal purchase: ${d.itemName}`, date: d.date },
      });
    }
  });

  revalidatePath(`/${slug}/internal-purchases`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deleteInternalPurchase(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  await prisma.$transaction(async (tx) => {
    // Delete the linked treasury deduction first, if any — the FK is
    // ON DELETE SET NULL, which would otherwise leave a stray entry behind
    // still counting against the treasury balance for an entry that no
    // longer exists.
    await tx.treasuryEntry.deleteMany({ where: { workspaceId, internalPurchaseId: id } });
    await tx.internalPurchase.deleteMany({ where: { id, workspaceId } });
  });

  revalidatePath(`/${slug}/internal-purchases`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
