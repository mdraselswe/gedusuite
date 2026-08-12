import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * When a partner pays for something out of their own pocket, that single act
 * is two things at once: money entering the business (an INVESTMENT credit)
 * and money being spent (the purchase itself, already tagged "paid by"). Only
 * the spend side used to be recorded automatically — the credit had to be
 * typed into the partner's ledger by hand, and a forgotten one silently ate
 * into that partner's "remaining".
 *
 * So the credit is now derived: one source row, one linked PartnerTxn, kept in
 * step by the helpers below. Boosting has worked this way since it shipped
 * (see boosting.ts) — this is the same idea for product and internal purchases.
 */

/** Which source row a credit belongs to. Exactly one field, never both. */
export type CreditLink = { purchaseId: string } | { internalPurchaseId: string };

/** The link columns that mark a ledger row as generated rather than typed in. */
export const DERIVED_SELECT = {
  distributionId: true,
  boostSpendId: true,
  purchaseId: true,
  internalPurchaseId: true,
} as const;

type DerivedFields = { [K in keyof typeof DERIVED_SELECT]: string | null };

/** Stable value for filtering and comparison — the tag is display text. */
export type DerivedKind = "distribution" | "boost" | "purchase" | "internalPurchase";

export type DerivedSource = { kind: DerivedKind; tag: string; phrase: string };

/**
 * What a ledger row was generated from — `kind` to filter on, `tag` for the
 * table cell, `phrase` for the "you can't delete this" message — or null when
 * someone typed it in. A generated row is only editable through its source,
 * which is the whole point: two places to change one number is how the
 * numbers drift apart.
 */
export function derivedSource(t: DerivedFields): DerivedSource | null {
  if (t.distributionId) {
    return { kind: "distribution", tag: "from distribution", phrase: "a profit distribution" };
  }
  if (t.boostSpendId) {
    return { kind: "boost", tag: "from boosting", phrase: "a partner-funded boost spend" };
  }
  if (t.purchaseId) {
    return {
      kind: "purchase",
      tag: "from product purchase",
      phrase: "a partner-funded product purchase",
    };
  }
  if (t.internalPurchaseId) {
    return {
      kind: "internalPurchase",
      tag: "from internal purchase",
      phrase: "a partner-funded internal purchase",
    };
  }
  return null;
}

/**
 * Make the linked INVESTMENT credit match the purchase — creating, updating or
 * removing it as needed. Safe to call on every save: passing a null partnerId
 * (funding switched to treasury or to nothing) drops the credit.
 *
 * Must run inside the same transaction as the purchase write, so a purchase
 * can never exist without its credit.
 */
export async function syncPartnerCredit(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    link: CreditLink;
    partnerId: string | null;
    amount: number;
    purpose: string;
    date: Date;
    /** Whether `date` is a moment or only a day — mirrored from the source row. */
    dateHasTime: boolean;
  },
): Promise<void> {
  const { workspaceId, link, partnerId, amount, purpose, date, dateHasTime } = args;
  if (!partnerId) {
    await removePartnerCredit(tx, workspaceId, link);
    return;
  }

  const existing = await tx.partnerTxn.findFirst({
    where: { workspaceId, ...link },
    select: { id: true },
  });
  if (existing) {
    // Covers a changed cost, a changed date, and the purchase being reassigned
    // to a different partner — the credit follows the purchase in every case.
    await tx.partnerTxn.update({
      where: { id: existing.id },
      data: { partnerId, type: "INVESTMENT", amount, purpose, date, dateHasTime },
    });
    return;
  }
  await tx.partnerTxn.create({
    data: {
      workspaceId,
      partnerId,
      type: "INVESTMENT",
      amount,
      purpose,
      date,
      dateHasTime,
      ...link,
    },
  });
}

/**
 * Drop the linked credit. The FK cascades when the source row is deleted, but
 * the delete actions call this explicitly so the intent reads in the action
 * rather than being buried in the schema.
 */
export async function removePartnerCredit(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  link: CreditLink,
): Promise<void> {
  await tx.partnerTxn.deleteMany({ where: { workspaceId, ...link } });
}

/**
 * Partner-funded rows from before the credit was derived — they may or may not
 * have a hand-typed credit somewhere in the ledger, which is why they can't be
 * backfilled blindly. Counted here to drive the "needs reconciling" prompt.
 */
export async function unlinkedPartnerFundingCount(workspaceId: string): Promise<number> {
  const where = { workspaceId, paidByPartnerId: { not: null }, partnerTxn: { is: null } };
  const [purchases, internal] = await Promise.all([
    prisma.purchase.count({ where }),
    prisma.internalPurchase.count({ where }),
  ]);
  return purchases + internal;
}
