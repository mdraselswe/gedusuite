"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { InsufficientTreasury, assertTreasuryCovers } from "@/lib/finance";
import { ConcurrentWrite, runSerializable } from "@/lib/tx";
import { removePartnerCredit, syncPartnerCredit } from "@/lib/partner-credit";

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
  supplierId: z.string().optional().or(z.literal("")),
  // Funding source is one of three mutually exclusive states — driven by a
  // single field instead of trying to infer exclusivity from two raw ones.
  fundingSource: z.enum(["NONE", "PARTNER", "TREASURY"]).default("NONE"),
  paidByPartnerId: z.string().optional().or(z.literal("")),
  cost: z.coerce.number().nonnegative("Cost must be ≥ 0"),
  quantity: z.coerce.number().int().positive("Quantity must be > 0"),
  category: z.enum(CATEGORIES),
  date: z.coerce.date(),
  // Blank means "charge it in full on its date" — not zero months, which would
  // be a window of no length. Stripped before coercion so "" doesn't become 0.
  spreadMonths: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int().min(1).max(120).optional(),
  ),
});

function parse(formData: FormData) {
  return Schema.safeParse({
    itemName: formData.get("itemName"),
    description: formData.get("description") ?? undefined,
    supplierId: formData.get("supplierId") ?? undefined,
    fundingSource: formData.get("fundingSource") ?? "NONE",
    paidByPartnerId: formData.get("paidByPartnerId") ?? undefined,
    cost: formData.get("cost"),
    quantity: formData.get("quantity"),
    category: formData.get("category"),
    date: formData.get("date"),
    spreadMonths: formData.get("spreadMonths") ?? undefined,
  });
}

const clean = (s?: string) => (s && s.trim() ? s.trim() : null);
const MODULE = "internal-purchases" as const;

/**
 * Funding touches three ledgers besides this list. Partners is revalidated as
 * a layout so the per-partner detail pages — where the derived credit shows —
 * are refreshed too, not just the list.
 */
function revalidateAll(slug: string) {
  revalidatePath(`/${slug}/internal-purchases`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/partners`, "layout");
  revalidatePath(`/${slug}/dashboard`);
}

/** Resolve a supplierId to {id, name} within the workspace, or null if none given. */
async function resolveSupplier(workspaceId: string, supplierId?: string) {
  if (!supplierId) return null;
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, workspaceId },
    select: { id: true, name: true },
  });
  return supplier;
}

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
  const supplier = await resolveSupplier(workspaceId, d.supplierId);

  const cost = round2(d.cost * d.quantity);

  try {
    await runSerializable(async (tx) => {
      // Inside the transaction so two people saving at once can't both spend
      // the same balance.
      if (paidFromTreasury) await assertTreasuryCovers(tx, workspaceId, cost);
      const item = await tx.internalPurchase.create({
      data: {
        workspaceId,
        itemName: d.itemName,
        description: clean(d.description),
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
        paidByPartnerId,
        paidFromTreasury,
        cost: d.cost,
        quantity: d.quantity,
        category: d.category,
        date: d.date,
        spreadMonths: d.spreadMonths ?? null,
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
    if (paidByPartnerId) {
      await syncPartnerCredit(tx, {
        workspaceId,
        link: { internalPurchaseId: item.id },
        partnerId: paidByPartnerId,
        amount: cost,
        purpose: `Internal purchase: ${d.itemName}`,
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

  revalidateAll(slug);
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
  const supplier = await resolveSupplier(workspaceId, d.supplierId);
  const newCost = round2(d.cost * d.quantity);
  const wasTreasuryFunded = existing.paidFromTreasury;
  const oldEntryAmount = existing.treasuryEntry ? Number(existing.treasuryEntry.amount) : 0;

  try {
    await runSerializable(async (tx) => {
      // Becoming treasury-funded, or staying so with a changed cost — either
      // way the balance has to cover it. When it was already treasury-funded
      // the old entry's amount is credited back: that money is being replaced,
      // not spent a second time.
      if (paidFromTreasury) {
        await assertTreasuryCovers(
          tx,
          workspaceId,
          newCost,
          wasTreasuryFunded ? oldEntryAmount : 0,
        );
      }
      await tx.internalPurchase.update({
      where: { id },
      data: {
        itemName: d.itemName,
        description: clean(d.description),
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? null,
        paidByPartnerId,
        paidFromTreasury,
        cost: d.cost,
        quantity: d.quantity,
        category: d.category,
        date: d.date,
        spreadMonths: d.spreadMonths ?? null,
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

    // Unconditional: this one call covers becoming partner-funded, ceasing to
    // be, switching partner, and a plain cost change.
    await syncPartnerCredit(tx, {
      workspaceId,
      link: { internalPurchaseId: id },
      partnerId: paidByPartnerId,
      amount: newCost,
      purpose: `Internal purchase: ${d.itemName}`,
      date: d.date,
    });
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  revalidateAll(slug);
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
    await removePartnerCredit(tx, workspaceId, { internalPurchaseId: id });
    await tx.internalPurchase.deleteMany({ where: { id, workspaceId } });
  });

  revalidateAll(slug);
  return { ok: true };
}
