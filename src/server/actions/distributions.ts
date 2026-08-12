"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import {
  InsufficientTreasury,
  assertTreasuryCovers,
  supplierDueTotal,
  totalBusinessProfit,
  treasuryBalance,
} from "@/lib/finance";
import { ConcurrentWrite, runSerializable } from "@/lib/tx";
import { beyondDistributableProfit, splitByShare } from "@/lib/profit-share";
import { failed, type ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";
import { dhakaDateField } from "@/lib/date-field";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type ActionResult =
  | { ok: true }
  | ActionFailure
  // Not a refusal: something the person should see before it happens. The UI
  // puts it in front of them and re-submits with confirmBeyondProfit set.
  | { ok: false; error: string; confirm: true };

const DistributionSchema = z.object({
  amount: z.coerce.number().positive("Amount must be > 0"),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  date: dhakaDateField,
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
    return failed(parsed.error);
  }
  const d = parsed.data;

  const partners = await prisma.partner.findMany({
    where: { workspaceId, profitSharePercent: { gt: 0 } },
    select: {
      id: true,
      profitSharePercent: true,
      // For the history line: a distribution is remembered by who got what.
      user: { select: { name: true, email: true } },
    },
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
  //
  // Measured against what is LEFT of the profit, not against the lifetime
  // total. The lifetime figure never moves when partners are paid, so the same
  // 200,000 could be distributed in March and again in April with nothing
  // saying a word — the second one being capital in all but name.
  const [profit, supplierDue, treasury] = await Promise.all([
    totalBusinessProfit(workspaceId),
    // Only the total is needed here. businessCapitalSummary would answer it too,
    // but it values every variant's stock and rebuilds every partner balance on
    // the way — a lot of database for one number on a path someone is waiting on.
    supplierDueTotal(workspaceId),
    treasuryBalance(workspaceId),
  ]);
  const left = profit.distributableProfit;
  const beyondProfit = beyondDistributableProfit(left, d.amount);

  // Both reasons are gathered before anything is returned, and both go into the
  // same confirmation. They used to be two early returns behind one flag, so
  // confirming the first silently waived the second: someone warned about the
  // supplier bill was never told the money wasn't profit either.
  const warnings: string[] = [];
  if (beyondProfit > 0) {
    const alreadyOut =
      profit.distributed > 0
        ? ` The business has earned ${profit.netProfit.toFixed(2)} in total and ${profit.distributed.toFixed(2)} of that has already been distributed.`
        : "";
    warnings.push(
      left <= 0
        ? `There is no profit left to distribute — remaining distributable profit is ${left.toFixed(2)}. ` +
          `All ${d.amount.toFixed(2)} of this would come out of capital and sales cash, ` +
          `which is what pays for the next restock.${alreadyOut}`
        : `Remaining distributable profit is ${left.toFixed(2)}, so ${beyondProfit.toFixed(2)} ` +
          `of this comes out of capital and sales cash rather than profit.${alreadyOut}`,
    );
  }
  // Money owed to a supplier is spoken for whatever the treasury balance says.
  // Handing it to partners and then finding the bill is the failure this whole
  // confirmation exists to prevent, one creditor further along.
  const leftAfter = round2(treasury - d.amount);
  if (supplierDue > 0 && leftAfter < supplierDue) {
    warnings.push(
      `${supplierDue.toFixed(2)} is owed to suppliers for goods bought on credit. ` +
        `Taking ${d.amount.toFixed(2)} out leaves ${leftAfter.toFixed(2)} in the treasury, ` +
        `which doesn't cover it.`,
    );
  }
  if (warnings.length > 0 && !d.confirmBeyondProfit) {
    return { ok: false, confirm: true, error: warnings.join(" ") };
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

  let distributionId: string;
  try {
    distributionId = await runSerializable(async (tx) => {
      // Checked here rather than before the transaction: two distributions
      // approved at the same moment would otherwise both pass and overdraw.
      await assertTreasuryCovers(tx, workspaceId, d.amount);
      const distribution = await tx.profitDistribution.create({
      data: {
        workspaceId,
        totalAmount: d.amount,
        note,
        date: d.date.at,
        dateHasTime: d.date.hasTime,
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
        date: d.date.at,
        dateHasTime: d.date.hasTime,
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
          date: d.date.at,
        dateHasTime: d.date.hasTime,
        },
      });
    }
    return distribution.id;
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  // Handing out money is the decision partners most want a record of, so the
  // line carries who got what rather than only the total.
  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "ProfitDistribution",
    entityId: distributionId,
    entityLabel: `৳${d.amount}`,
    summary:
      `Distributed ৳${d.amount} — ` +
      cuts
        .filter((c) => c.amount > 0)
        .map((c) => {
          const p = partners.find((x) => x.id === c.partnerId);
          return `${p?.user.name ?? p?.user.email ?? "partner"} ৳${c.amount}`;
        })
        .join(", ") +
      (beyondProfit > 0 ? ` (৳${beyondProfit} beyond profit)` : ""),
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
    select: { id: true, totalAmount: true, date: true },
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

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "ProfitDistribution",
    entityId: id,
    entityLabel: `৳${Number(existing.totalAmount)}`,
    summary:
      `Distribution of ৳${Number(existing.totalAmount)} from ` +
      `${existing.date.toISOString().slice(0, 10)} undone — every partner's share went back`,
  });

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
