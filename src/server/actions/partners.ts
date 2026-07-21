"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

const PartnerSchema = z.object({
  userId: z.string().min(1, "Select a member"),
  profitSharePercent: z.coerce.number().min(0).max(100),
  notes: z.string().trim().max(300).optional().or(z.literal("")),
});

export async function createPartner(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "partners", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = PartnerSchema.safeParse({
    userId: formData.get("userId"),
    profitSharePercent: formData.get("profitSharePercent") ?? 0,
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  // The selected user must be a member of this workspace.
  const membership = await prisma.membership.findFirst({
    where: { userId: d.userId, workspaceId },
    select: { id: true },
  });
  if (!membership) return { ok: false, error: "That user is not a member" };

  const existing = await prisma.partner.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: d.userId } },
  });
  if (existing) return { ok: false, error: "That member is already a partner" };

  await prisma.partner.create({
    data: {
      workspaceId,
      userId: d.userId,
      profitSharePercent: d.profitSharePercent,
      notes: d.notes?.trim() || null,
    },
  });
  revalidatePath(`/${slug}/partners`);
  return { ok: true };
}

export async function updatePartner(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "partners", "full");
  if (!gate.ok) return gate;

  const percent = Number(formData.get("profitSharePercent") ?? 0);
  if (Number.isNaN(percent) || percent < 0 || percent > 100) {
    return { ok: false, error: "Profit share must be 0–100" };
  }
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const res = await prisma.partner.updateMany({
    where: { id, workspaceId: gate.access.workspaceId },
    data: { profitSharePercent: percent, notes },
  });
  if (res.count === 0) return { ok: false, error: "Partner not found" };
  revalidatePath(`/${slug}/partners`);
  return { ok: true };
}

export async function deletePartner(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "partners", "full");
  if (!gate.ok) return gate;
  await prisma.partner.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/partners`);
  return { ok: true };
}

const TxnSchema = z.object({
  partnerId: z.string().min(1),
  type: z.enum(["INVESTMENT", "EXPENSE", "WITHDRAWAL", "DEPOSIT_TO_TREASURY"]),
  amount: z.coerce.number().positive("Amount must be > 0"),
  purpose: z.string().trim().max(300).optional().or(z.literal("")),
  date: z.coerce.date(),
});

export async function createPartnerTxn(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "partners", "add");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = TxnSchema.safeParse({
    partnerId: formData.get("partnerId"),
    type: formData.get("type"),
    amount: formData.get("amount"),
    purpose: formData.get("purpose") ?? undefined,
    date: formData.get("date"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  const partner = await prisma.partner.findFirst({
    where: { id: d.partnerId, workspaceId },
    select: { id: true, userId: true },
  });
  if (!partner) return { ok: false, error: "Partner not found" };

  // Row-level: a PARTNER may only add transactions to their own record.
  if (gate.access.role === "PARTNER" && partner.userId !== gate.access.userId) {
    return { ok: false, error: "You can only add your own transactions" };
  }

  await prisma.partnerTxn.create({
    data: {
      workspaceId,
      partnerId: d.partnerId,
      type: d.type,
      amount: d.amount,
      purpose: d.purpose?.trim() || null,
      date: d.date,
      // Depositing to treasury auto-creates a linked IN entry in the ledger.
      treasuryEntry:
        d.type === "DEPOSIT_TO_TREASURY"
          ? {
              create: {
                workspaceId,
                type: "IN",
                amount: d.amount,
                source: "Partner deposit",
                note: d.purpose?.trim() || null,
                partnerId: d.partnerId,
                date: d.date,
              },
            }
          : undefined,
    },
  });

  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deletePartnerTxn(
  slug: string,
  id: string,
): Promise<ActionResult> {
  // Editing/deleting finance records is OWNER-level (partners "edit").
  const gate = await requireAccess(slug, "partners", "edit");
  if (!gate.ok) return gate;

  const txn = await prisma.partnerTxn.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { distributionId: true },
  });
  if (!txn) return { ok: false, error: "Transaction not found" };
  if (txn.distributionId) {
    return {
      ok: false,
      error: "This came from a profit distribution — delete the whole distribution instead",
    };
  }

  await prisma.partnerTxn.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/treasury`);
  return { ok: true };
}
