"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { InsufficientTreasury, assertTreasuryCovers, totalBusinessProfit } from "@/lib/finance";
import { ConcurrentWrite, runSerializable } from "@/lib/tx";
import { splitByShare } from "@/lib/profit-share";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type ActionResult =
  | { ok: true }
  | { ok: false; error: string }
  // Not a refusal: something the person should see before it happens. The UI
  // puts it in front of them and re-submits with confirmBeyondProfit set.
  | { ok: false; error: string; confirm: true };

const DistributionSchema = z.object({
  amount: z.coerce.number().positive("Amount must be > 0"),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  date: z.coerce.date(),
  /** Set once the person has been told the amount exceeds profit. */
  confirmBeyondProfit: z.coerce.boolean().default(false),
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
    confirmBeyondProfit: formData.get("confirmBeyondProfit") === "true",
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

  // Cash is not the same question as profit, and only cash was ever asked.
  // A treasury holding sales takings will happily fund a "profit distribution"
  // in a month that made no profit at all — the money is real, but what's being
  // handed out is working capital, and the next restock is what pays for it.
  // Not blocked: withdrawing capital is a decision partners are allowed to
  // make. It just can't be made by accident any more.
  const profit = await totalBusinessProfit(workspaceId);
  const beyondProfit = round2(d.amount - Math.max(0, profit.netProfit));
  if (beyondProfit > 0 && !d.confirmBeyondProfit) {
    return {
      ok: false,
      confirm: true,
      error:
        profit.netProfit <= 0
          ? `There is no distributable profit — the business is at ${profit.netProfit.toFixed(2)}. ` +
            `All ${d.amount.toFixed(2)} of this would come out of capital and sales cash, ` +
            `which is what pays for the next restock.`
          : `Distributable profit is ${profit.netProfit.toFixed(2)}, so ${beyondProfit.toFixed(2)} ` +
            `of this comes out of capital and sales cash rather than profit.`,
    };
  }

  // Normalization and the rounding remainder both live in splitByShare now —
  // the screens that tell a partner what their share is call the same function,
  // so what they read and what they're paid can't drift apart.
  const cuts = splitByShare(
    partners.map((p) => ({ partnerId: p.id, percent: Number(p.profitSharePercent) })),
    d.amount,
  );

  // Both rows say "Profit distribution". When it wasn't one, the note says so —
  // otherwise the ledger records a withdrawal of capital under a name that
  // claims the business earned it.
  const capitalNote =
    beyondProfit > 0
      ? `${beyondProfit.toFixed(2)} of this was beyond distributable profit (capital / sales cash)`
      : null;
  const note = [d.note?.trim() || null, capitalNote].filter(Boolean).join(" — ") || null;

  try {
    await runSerializable(async (tx) => {
      // Checked here rather than before the transaction: two distributions
      // approved at the same moment would otherwise both pass and overdraw.
      await assertTreasuryCovers(tx, workspaceId, d.amount);
      const distribution = await tx.profitDistribution.create({
      data: {
        workspaceId,
        totalAmount: d.amount,
        note,
        date: d.date,
      },
    });
    await tx.treasuryEntry.create({
      data: {
        workspaceId,
        type: "OUT",
        amount: d.amount,
        source: "Profit distribution",
        note,
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
          purpose: beyondProfit > 0 ? "Distribution (beyond profit)" : "Profit distribution",
          distributionId: distribution.id,
          date: d.date,
        },
      });
    }
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

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
