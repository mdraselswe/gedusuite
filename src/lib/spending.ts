import { prisma } from "@/lib/prisma";
import { variantFullName } from "@/lib/variants";
import type { DateRange } from "@/lib/reports";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const n = (v: unknown) => Number(v ?? 0);

/**
 * What money actually left the business on a given day, and where it went.
 *
 * A question nothing in the app could answer. Reports work in expenses: stock
 * bought to resell doesn't reach them until it sells, and a cost with
 * spreadMonths is smeared across the months it covers. Both are right for
 * profit and neither tells you that ৳30,000 went out of the door on 1 April.
 *
 * Read from the source tables, NOT from the treasury ledger, for two reasons
 * that this shop's own data demonstrates. Most spending never touches the
 * treasury at all — a purchase from a partner's own pocket, or one taken on
 * credit, writes no treasury entry — so a ledger-based view would miss nearly
 * everything. And what the ledger does hold is mostly a mirror: a
 * treasury-funded purchase writes an OUT row carrying `purchaseId`, so adding
 * the ledger to the purchases would count it twice. Only a treasury OUT with
 * no link to anything is its own event, and those are the ones included here.
 */

/** The kinds of spending, in the order they're worth reading. */
export const SPEND_CATEGORIES = [
  "PRODUCT_PURCHASE",
  "INTERNAL_PURCHASE",
  "BOOSTING",
  "PARTNER_EXPENSE",
  "TREASURY_MANUAL",
] as const;
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];

export const spendCategoryLabel: Record<SpendCategory, string> = {
  PRODUCT_PURCHASE: "Product purchase (stock)",
  INTERNAL_PURCHASE: "Internal purchase",
  BOOSTING: "Boosting (ads)",
  PARTNER_EXPENSE: "Partner expense",
  TREASURY_MANUAL: "Treasury entry",
};

/** Whose money it was. The other half of "where did it go". */
export type SpendFunding = "TREASURY" | "PARTNER" | "CREDIT" | "UNRECORDED";

export const spendFundingLabel: Record<SpendFunding, string> = {
  TREASURY: "From the treasury",
  PARTNER: "From a partner's own money",
  CREDIT: "On credit — not paid yet",
  UNRECORDED: "Nobody recorded who paid",
};

export type SpendRow = {
  id: string;
  date: string;
  category: SpendCategory;
  /** What it was — a product name, an item, a campaign. */
  label: string;
  /** Supplier, partner, ad set — whatever narrows it further. Optional. */
  detail: string | null;
  funding: SpendFunding;
  /** Named partner, when one paid. */
  paidBy: string | null;
  amount: number;
  /** Where to go to see or edit it. */
  href: string;
};

/**
 * Money that left but isn't spending: partners taking their profit or their
 * capital back. Real cash movement, and emphatically not a cost — counting it
 * as one would report a shop that paid its partners as having had an expensive
 * day.
 */
export type PayoutRow = {
  id: string;
  date: string;
  label: string;
  paidBy: string | null;
  amount: number;
};

export type SpendingSummary = {
  rows: SpendRow[];
  payouts: PayoutRow[];
  total: number;
  byCategory: { category: SpendCategory; amount: number; count: number }[];
  byFunding: { funding: SpendFunding; amount: number; count: number }[];
  payoutTotal: number;
};

/** A purchase's funding, as one of the four mutually exclusive states. */
function fundingOf(p: {
  paidFromTreasury: boolean;
  paidByPartnerId: string | null;
  onCredit: boolean;
}): SpendFunding {
  if (p.paidFromTreasury) return "TREASURY";
  if (p.paidByPartnerId) return "PARTNER";
  if (p.onCredit) return "CREDIT";
  return "UNRECORDED";
}

export async function spendingForRange(
  workspaceId: string,
  range: DateRange,
  slug: string,
): Promise<SpendingSummary> {
  const where = { workspaceId, date: { gte: range.from, lte: range.to } };
  const partnerName = (p: { user: { name: string | null; email: string } } | null) =>
    p ? (p.user.name ?? p.user.email) : null;

  const [purchases, internals, boosts, partnerExpenses, treasuryOut, distributions, withdrawals] =
    await Promise.all([
      prisma.purchase.findMany({
        where,
        include: {
          supplier: { select: { name: true } },
          paidByPartner: { include: { user: { select: { name: true, email: true } } } },
          productVariant: {
            select: { attributes: true, product: { select: { name: true } } },
          },
        },
        orderBy: { date: "asc" },
      }),
      prisma.internalPurchase.findMany({
        where,
        include: {
          paidByPartner: { include: { user: { select: { name: true, email: true } } } },
        },
        orderBy: { date: "asc" },
      }),
      prisma.boostDailySpend.findMany({
        where,
        include: {
          paidByPartner: { include: { user: { select: { name: true, email: true } } } },
          adSet: { select: { name: true, campaign: { select: { id: true, name: true } } } },
        },
        orderBy: { date: "asc" },
      }),
      prisma.partnerTxn.findMany({
        where: { ...where, type: "EXPENSE" },
        include: { partner: { include: { user: { select: { name: true, email: true } } } } },
        orderBy: { date: "asc" },
      }),
      // Hand-entered only. Every link here means the row mirrors something
      // already counted above — including it would double the amount.
      prisma.treasuryEntry.findMany({
        where: {
          ...where,
          type: "OUT",
          partnerTxnId: null,
          orderId: null,
          purchaseId: null,
          internalPurchaseId: null,
          distributionId: null,
          boostSpendId: null,
        },
        orderBy: { date: "asc" },
      }),
      prisma.profitDistribution.findMany({ where, orderBy: { date: "asc" } }),
      prisma.partnerTxn.findMany({
        where: { ...where, type: "WITHDRAWAL", distributionId: null },
        include: { partner: { include: { user: { select: { name: true, email: true } } } } },
        orderBy: { date: "asc" },
      }),
    ]);

  const day = (d: Date) => d.toISOString().slice(0, 10);
  const rows: SpendRow[] = [
    ...purchases.map((p) => ({
      id: `pu-${p.id}`,
      date: day(p.date),
      category: "PRODUCT_PURCHASE" as const,
      label: variantFullName(p.productVariant.product.name, p.productVariant.attributes),
      detail: p.supplier?.name ? `${p.quantity} × from ${p.supplier.name}` : `${p.quantity} pcs`,
      funding: fundingOf(p),
      paidBy: partnerName(p.paidByPartner),
      amount: round2(n(p.unitCost) * p.quantity),
      href: `/${slug}/purchases`,
    })),
    ...internals.map((ip) => ({
      id: `ip-${ip.id}`,
      date: day(ip.date),
      category: "INTERNAL_PURCHASE" as const,
      label: ip.itemName,
      detail: ip.supplierName ?? (ip.quantity > 1 ? `${ip.quantity} pcs` : null),
      funding: fundingOf(ip),
      paidBy: partnerName(ip.paidByPartner),
      amount: round2(n(ip.cost) * ip.quantity),
      href: `/${slug}/internal-purchases`,
    })),
    ...boosts.map((b) => ({
      id: `bs-${b.id}`,
      date: day(b.date),
      category: "BOOSTING" as const,
      label: b.adSet.campaign.name,
      detail: b.adSet.name,
      // Boost spends have no credit state — an ad is paid when it runs.
      funding: b.paidFromTreasury
        ? ("TREASURY" as const)
        : b.paidByPartnerId
          ? ("PARTNER" as const)
          : ("UNRECORDED" as const),
      paidBy: partnerName(b.paidByPartner),
      amount: round2(n(b.amount)),
      href: `/${slug}/boosting/${b.adSet.campaign.id}`,
    })),
    ...partnerExpenses.map((t) => ({
      id: `px-${t.id}`,
      date: day(t.date),
      category: "PARTNER_EXPENSE" as const,
      label: t.purpose ?? "Expense",
      detail: null,
      // A partner's manual expense is their own money by definition.
      funding: "PARTNER" as const,
      paidBy: partnerName(t.partner),
      amount: round2(n(t.amount)),
      href: `/${slug}/partners/${t.partnerId}`,
    })),
    ...treasuryOut.map((e) => ({
      id: `te-${e.id}`,
      date: day(e.date),
      category: "TREASURY_MANUAL" as const,
      label: e.source,
      detail: e.note,
      funding: "TREASURY" as const,
      paidBy: null,
      amount: round2(n(e.amount)),
      href: `/${slug}/treasury`,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);

  const payouts: PayoutRow[] = [
    ...distributions.map((d) => ({
      id: `pd-${d.id}`,
      date: day(d.date),
      label: "Profit distribution",
      paidBy: null,
      amount: round2(n(d.totalAmount)),
    })),
    ...withdrawals.map((w) => ({
      id: `pw-${w.id}`,
      date: day(w.date),
      label: w.purpose ?? "Capital taken back",
      paidBy: partnerName(w.partner),
      amount: round2(n(w.amount)),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const sumBy = <K extends string>(keys: readonly K[], pick: (r: SpendRow) => K) => {
    const acc = new Map<K, { amount: number; count: number }>();
    for (const r of rows) {
      const k = pick(r);
      const cur = acc.get(k) ?? { amount: 0, count: 0 };
      cur.amount += r.amount;
      cur.count += 1;
      acc.set(k, cur);
    }
    return keys
      .filter((k) => acc.has(k))
      .map((k) => ({ key: k, amount: round2(acc.get(k)!.amount), count: acc.get(k)!.count }));
  };

  return {
    rows,
    payouts,
    total: round2(rows.reduce((s, r) => s + r.amount, 0)),
    byCategory: sumBy(SPEND_CATEGORIES, (r) => r.category).map((x) => ({
      category: x.key,
      amount: x.amount,
      count: x.count,
    })),
    byFunding: sumBy(
      ["TREASURY", "PARTNER", "CREDIT", "UNRECORDED"] as const,
      (r) => r.funding,
    ).map((x) => ({ funding: x.key, amount: x.amount, count: x.count })),
    payoutTotal: round2(payouts.reduce((s, p) => s + p.amount, 0)),
  };
}
