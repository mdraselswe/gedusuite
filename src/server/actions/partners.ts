"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import {
  DERIVED_SELECT,
  derivedSource,
  syncPartnerCredit,
  type CreditLink,
} from "@/lib/partner-credit";
import { variantFullName } from "@/lib/variants";

export type ActionResult = { ok: true } | { ok: false; error: string };

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

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

/**
 * Remove a partner who has no financial history.
 *
 * PartnerTxn cascades from Partner, and TreasuryEntry cascades from PartnerTxn,
 * so this one delete used to run the whole chain: every investment, withdrawal
 * and expense the partner ever recorded, plus the treasury IN entry behind each
 * deposit they made. Money physically sitting in the treasury would drop off
 * the ledger, and a profit distribution would keep its total while losing the
 * cuts that made it up.
 *
 * Every other delete in the finance modules already refuses to break a derived
 * row — deleteTreasuryEntry checks six links, deletePartnerTxn checks four.
 * This one checked nothing, and had the largest blast radius of them all.
 */
export async function deletePartner(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "partners", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const partner = await prisma.partner.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      _count: { select: { txns: true, purchases: true, internalPurchases: true, boostSpends: true } },
    },
  });
  if (!partner) return { ok: false, error: "Partner not found" };

  const c = partner._count;
  if (c.txns > 0) {
    // Named separately because a deposit is the one that moves the treasury
    // balance, and that's the damage worth spelling out.
    const deposits = await prisma.partnerTxn.count({
      where: { workspaceId, partnerId: id, type: "DEPOSIT_TO_TREASURY" },
    });
    return {
      ok: false,
      error:
        `This partner has ${c.txns} ledger entries and can't be removed — deleting them would ` +
        (deposits > 0
          ? `take ${deposits} treasury deposit(s) out of the treasury balance, for money that is still there. `
          : `erase the record of what they put in and took out. `) +
        `Set their profit share to 0 instead if they're no longer active.`,
    };
  }
  // Funding links are SetNull, so these rows survive — but they'd be left
  // saying nobody paid for them, which is its own kind of wrong.
  const funded = c.purchases + c.internalPurchases + c.boostSpends;
  if (funded > 0) {
    return {
      ok: false,
      error:
        `This partner funded ${funded} purchase(s)/spend(s). Removing them would leave those ` +
        `records with no one recorded as having paid. Set their profit share to 0 instead.`,
    };
  }

  await prisma.partner.deleteMany({ where: { id, workspaceId } });
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

  revalidatePath(`/${slug}/partners`, "layout");
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
    select: DERIVED_SELECT,
  });
  if (!txn) return { ok: false, error: "Transaction not found" };
  const source = derivedSource(txn);
  if (source) {
    return {
      ok: false,
      error: `This came from ${source.phrase} — delete that entry instead`,
    };
  }

  await prisma.partnerTxn.deleteMany({
    where: { id, workspaceId: gate.access.workspaceId },
  });
  revalidatePath(`/${slug}/partners`, "layout");
  revalidatePath(`/${slug}/treasury`);
  return { ok: true };
}

// ── Reconciling pre-existing partner-funded rows ────────────────────
//
// Purchases made before the credit was derived have no linked PartnerTxn.
// Some already have a hand-typed credit sitting in the ledger and some don't,
// and nothing in the data distinguishes the two — which is why the migration
// backfills nothing and these actions exist instead. Each unlinked row is
// resolved one of two ways: adopt the manual credit that was already entered
// for it, or generate the credit that was never entered.

export type SourceKind = "PURCHASE" | "INTERNAL";

type UnlinkedSource = {
  partnerId: string;
  amount: number;
  date: Date;
  purpose: string;
  alreadyLinked: boolean;
  link: CreditLink;
};

async function loadSource(
  workspaceId: string,
  kind: SourceKind,
  sourceId: string,
): Promise<UnlinkedSource | null> {
  if (kind === "PURCHASE") {
    const p = await prisma.purchase.findFirst({
      where: { id: sourceId, workspaceId },
      select: {
        id: true,
        paidByPartnerId: true,
        unitCost: true,
        quantity: true,
        date: true,
        partnerTxn: { select: { id: true } },
        productVariant: {
          select: { attributes: true, product: { select: { name: true } } },
        },
      },
    });
    if (!p || !p.paidByPartnerId) return null;
    const label = variantFullName(p.productVariant.product.name, p.productVariant.attributes);
    return {
      partnerId: p.paidByPartnerId,
      amount: round2(Number(p.unitCost) * p.quantity),
      date: p.date,
      purpose: `Product purchase: ${label}`,
      alreadyLinked: !!p.partnerTxn,
      link: { purchaseId: p.id },
    };
  }
  const ip = await prisma.internalPurchase.findFirst({
    where: { id: sourceId, workspaceId },
    select: {
      id: true,
      paidByPartnerId: true,
      cost: true,
      quantity: true,
      date: true,
      itemName: true,
      partnerTxn: { select: { id: true } },
    },
  });
  if (!ip || !ip.paidByPartnerId) return null;
  return {
    partnerId: ip.paidByPartnerId,
    amount: round2(Number(ip.cost) * ip.quantity),
    date: ip.date,
    purpose: `Internal purchase: ${ip.itemName}`,
    alreadyLinked: !!ip.partnerTxn,
    link: { internalPurchaseId: ip.id },
  };
}

/**
 * Every still-unlinked partner-funded row for one partner, oldest first. Two
 * queries rather than one per row, and the ordering is what makes bulk
 * adoption predictable: an older purchase gets first claim on a matching
 * hand-typed entry, which is the order someone reading the ledger would pair
 * them in.
 */
async function loadUnlinkedSources(
  workspaceId: string,
  partnerId: string,
): Promise<UnlinkedSource[]> {
  const where = { workspaceId, paidByPartnerId: partnerId, partnerTxn: { is: null } } as const;
  const [purchases, internals] = await Promise.all([
    prisma.purchase.findMany({
      where,
      select: {
        id: true,
        unitCost: true,
        quantity: true,
        date: true,
        productVariant: { select: { attributes: true, product: { select: { name: true } } } },
      },
    }),
    prisma.internalPurchase.findMany({
      where,
      select: { id: true, cost: true, quantity: true, date: true, itemName: true },
    }),
  ]);

  return [
    ...purchases.map((p) => ({
      partnerId,
      amount: round2(Number(p.unitCost) * p.quantity),
      date: p.date,
      purpose: `Product purchase: ${variantFullName(
        p.productVariant.product.name,
        p.productVariant.attributes,
      )}`,
      alreadyLinked: false,
      link: { purchaseId: p.id } as CreditLink,
    })),
    ...internals.map((ip) => ({
      partnerId,
      amount: round2(Number(ip.cost) * ip.quantity),
      date: ip.date,
      purpose: `Internal purchase: ${ip.itemName}`,
      alreadyLinked: false,
      link: { internalPurchaseId: ip.id } as CreditLink,
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** No credit was ever entered for this purchase — create the missing one. */
export async function generatePartnerCredit(
  slug: string,
  kind: SourceKind,
  sourceId: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "partners", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const src = await loadSource(workspaceId, kind, sourceId);
  if (!src) return { ok: false, error: "That partner-funded purchase no longer exists" };
  if (src.alreadyLinked) return { ok: false, error: "This one already has a credit" };

  await prisma.$transaction(async (tx) => {
    await syncPartnerCredit(tx, {
      workspaceId,
      link: src.link,
      partnerId: src.partnerId,
      amount: src.amount,
      purpose: src.purpose,
      date: src.date,
    });
  });

  revalidatePath(`/${slug}/partners`, "layout");
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

/**
 * A credit for this purchase was already typed in by hand — attach it to the
 * purchase instead of adding a second one. The amounts must match exactly: a
 * lump-sum entry covering several purchases can't be adopted by any one of
 * them, and quietly stretching it to fit would lose the difference.
 */
export async function adoptPartnerCredit(
  slug: string,
  kind: SourceKind,
  sourceId: string,
  txnId: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "partners", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const [src, txn] = await Promise.all([
    loadSource(workspaceId, kind, sourceId),
    prisma.partnerTxn.findFirst({
      where: { id: txnId, workspaceId },
      select: { id: true, partnerId: true, type: true, amount: true, ...DERIVED_SELECT },
    }),
  ]);
  if (!src) return { ok: false, error: "That partner-funded purchase no longer exists" };
  if (src.alreadyLinked) return { ok: false, error: "This one already has a credit" };
  if (!txn) return { ok: false, error: "That ledger entry no longer exists" };
  if (derivedSource(txn)) {
    return { ok: false, error: "That entry already belongs to something else" };
  }
  if (txn.type !== "INVESTMENT") {
    return { ok: false, error: "Only an Investment entry can be a purchase credit" };
  }
  if (txn.partnerId !== src.partnerId) {
    return { ok: false, error: "That entry belongs to a different partner" };
  }
  if (round2(Number(txn.amount)) !== src.amount) {
    return {
      ok: false,
      error: "Amounts don't match — delete that entry and generate a fresh credit instead",
    };
  }

  // Rewritten to the purchase's own wording and date, so an adopted credit is
  // indistinguishable from a generated one and stays in step from here on.
  await prisma.partnerTxn.update({
    where: { id: txn.id },
    data: { purpose: src.purpose, date: src.date, ...src.link },
  });

  revalidatePath(`/${slug}/partners`, "layout");
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

/**
 * Generate credits for every unlinked partner-funded row at once. Only safe
 * once the partner has no leftover hand-typed credits — the reconcile screen
 * spells that out before offering this.
 */
export async function generateAllPartnerCredits(
  slug: string,
  partnerId: string,
): Promise<{ ok: true; created: number } | { ok: false; error: string }> {
  const gate = await requireAccess(slug, "partners", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const partner = await prisma.partner.findFirst({
    where: { id: partnerId, workspaceId },
    select: { id: true },
  });
  if (!partner) return { ok: false, error: "Partner not found" };

  const sources = await loadUnlinkedSources(workspaceId, partnerId);
  if (sources.length === 0) return { ok: true, created: 0 };

  // One statement rather than a row-at-a-time loop inside an interactive
  // transaction: fifty round trips to a remote database blow past Prisma's
  // transaction timeout, and createMany is atomic on its own anyway. Every
  // source here is known to be unlinked, so these are all inserts — and the
  // unique index on purchaseId/internalPurchaseId is the backstop if someone
  // links one of them from another tab while this runs.
  const res = await prisma.partnerTxn.createMany({
    data: sources.map((src) => ({
      workspaceId,
      partnerId: src.partnerId,
      type: "INVESTMENT" as const,
      amount: src.amount,
      purpose: src.purpose,
      date: src.date,
      ...src.link,
    })),
  });

  revalidatePath(`/${slug}/partners`, "layout");
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true, created: res.count };
}

/**
 * Adopt every hand-typed credit whose amount matches a purchase exactly, in
 * one pass. Nothing is created and nothing is deleted — each match just gets
 * tied to its purchase, so the totals can't move.
 *
 * Pairing is greedy over purchases oldest-first, and an entry can only be
 * claimed once: three 60.00 purchases against a single 60.00 entry resolve to
 * one adoption, not three. Where several entries could match, the one dated
 * closest to the purchase wins.
 */
export async function adoptAllMatchedCredits(
  slug: string,
  partnerId: string,
): Promise<{ ok: true; adopted: number } | { ok: false; error: string }> {
  const gate = await requireAccess(slug, "partners", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const partner = await prisma.partner.findFirst({
    where: { id: partnerId, workspaceId },
    select: { id: true },
  });
  if (!partner) return { ok: false, error: "Partner not found" };

  const [sources, candidates] = await Promise.all([
    loadUnlinkedSources(workspaceId, partnerId),
    prisma.partnerTxn.findMany({
      where: {
        workspaceId,
        partnerId,
        type: "INVESTMENT",
        distributionId: null,
        boostSpendId: null,
        purchaseId: null,
        internalPurchaseId: null,
      },
      select: { id: true, amount: true, date: true },
    }),
  ]);

  const pool = candidates.map((c) => ({
    id: c.id,
    amount: round2(Number(c.amount)),
    time: c.date.getTime(),
  }));
  const pairs: { txnId: string; src: UnlinkedSource }[] = [];
  for (const src of sources) {
    let best = -1;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].amount !== src.amount) continue;
      if (best === -1) {
        best = i;
        continue;
      }
      const gap = Math.abs(pool[i].time - src.date.getTime());
      const bestGap = Math.abs(pool[best].time - src.date.getTime());
      if (gap < bestGap) best = i;
    }
    if (best === -1) continue;
    pairs.push({ txnId: pool[best].id, src });
    pool.splice(best, 1);
  }
  if (pairs.length === 0) return { ok: true, adopted: 0 };

  // Each row gets different values, so there's no single-statement form —
  // it stays a loop, with headroom over the 5s default for a partner with a
  // lot of matches on a remote database.
  await prisma.$transaction(
    pairs.map(({ txnId, src }) =>
      prisma.partnerTxn.update({
        where: { id: txnId },
        data: { purpose: src.purpose, date: src.date, ...src.link },
      }),
    ),
  );

  revalidatePath(`/${slug}/partners`, "layout");
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true, adopted: pairs.length };
}
