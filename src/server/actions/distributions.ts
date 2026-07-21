"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { treasuryBalance } from "@/lib/finance";

export type ActionResult = { ok: true } | { ok: false; error: string };

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

const DistributionSchema = z.object({
  amount: z.coerce.number().positive("Amount must be > 0"),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  date: z.coerce.date(),
});

/**
 * Take a chosen amount out of the shared treasury and split it across every
 * partner by their profit-share percent — normalized so the full amount
 * always gets assigned even if the percents don't add up to exactly 100
 * (e.g. 60/30 splits proportionally into 66.67/33.33 of the amount, not
 * 60/30 of it with 10% left unassigned).
 */
export async function createDistribution(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = DistributionSchema.safeParse({
    amount: formData.get("amount"),
    note: formData.get("note") ?? undefined,
    date: formData.get("date"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;

  const partners = await prisma.partner.findMany({
    where: { workspaceId, profitSharePercent: { gt: 0 } },
    select: { id: true, profitSharePercent: true },
  });
  if (partners.length === 0) {
    return { ok: false, error: "No partners have a profit share set" };
  }

  const balance = await treasuryBalance(workspaceId);
  if (balance < d.amount) {
    return {
      ok: false,
      error: `Treasury balance is insufficient — available ${balance.toFixed(2)}, need ${d.amount.toFixed(2)}`,
    };
  }

  const totalPercent = partners.reduce((s, p) => s + Number(p.profitSharePercent), 0);

  // Normalize each partner's cut against the total percent actually in use
  // (not against 100), then fix up rounding so the cuts sum to exactly the
  // requested amount — the remainder (a few cents either way) goes to
  // whoever has the largest share, an arbitrary but consistent rule.
  const cuts = partners.map((p) => ({
    partnerId: p.id,
    percent: Number(p.profitSharePercent),
    amount: round2((Number(p.profitSharePercent) / totalPercent) * d.amount),
  }));
  const sumCuts = round2(cuts.reduce((s, c) => s + c.amount, 0));
  const remainder = round2(d.amount - sumCuts);
  if (remainder !== 0) {
    const largest = cuts.reduce((max, c) => (c.percent > max.percent ? c : max), cuts[0]);
    largest.amount = round2(largest.amount + remainder);
  }

  await prisma.$transaction(async (tx) => {
    const distribution = await tx.profitDistribution.create({
      data: {
        workspaceId,
        totalAmount: d.amount,
        note: d.note?.trim() || null,
        date: d.date,
      },
    });
    await tx.treasuryEntry.create({
      data: {
        workspaceId,
        type: "OUT",
        amount: d.amount,
        source: "Profit distribution",
        note: d.note?.trim() || null,
        distributionId: distribution.id,
        date: d.date,
      },
    });
    for (const cut of cuts) {
      if (cut.amount <= 0) continue;
      await tx.partnerTxn.create({
        data: {
          workspaceId,
          partnerId: cut.partnerId,
          type: "WITHDRAWAL",
          amount: cut.amount,
          purpose: "Profit distribution",
          distributionId: distribution.id,
          date: d.date,
        },
      });
    }
  });

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deleteDistribution(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const existing = await prisma.profitDistribution.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: "Distribution not found" };

  // The partner txns and treasury entry both cascade-delete via the FK
  // (onDelete: Cascade), but deleting them explicitly keeps this readable
  // and correct even if that ever changes.
  await prisma.$transaction(async (tx) => {
    await tx.partnerTxn.deleteMany({ where: { workspaceId, distributionId: id } });
    await tx.treasuryEntry.deleteMany({ where: { workspaceId, distributionId: id } });
    await tx.profitDistribution.delete({ where: { id } });
  });

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
