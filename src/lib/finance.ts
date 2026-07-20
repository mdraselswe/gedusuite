import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";

export const OVERDUE_DAYS = 7;

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type PartnerBalance = {
  partnerId: string;
  invested: number; // sum of INVESTMENT
  withdrawn: number; // sum of WITHDRAWAL
  expenses: number; // sum of EXPENSE
  depositedToTreasury: number; // sum of DEPOSIT_TO_TREASURY
  netCapital: number; // invested − withdrawn
  remaining: number; // invested − expenses − depositedToTreasury: what's left of their capital still to spend
};

/** Derive each partner's balances from their transaction log (never stored). */
export async function partnerBalances(
  workspaceId: string,
): Promise<Map<string, PartnerBalance>> {
  const rows = await prisma.partnerTxn.groupBy({
    by: ["partnerId", "type"],
    where: { workspaceId },
    _sum: { amount: true },
  });

  const map = new Map<string, PartnerBalance>();
  const ensure = (id: string): PartnerBalance =>
    map.get(id) ??
    map
      .set(id, {
        partnerId: id,
        invested: 0,
        withdrawn: 0,
        expenses: 0,
        depositedToTreasury: 0,
        netCapital: 0,
        remaining: 0,
      })
      .get(id)!;

  for (const r of rows) {
    const b = ensure(r.partnerId);
    const amt = Number(r._sum.amount ?? 0);
    if (r.type === "INVESTMENT") b.invested += amt;
    else if (r.type === "WITHDRAWAL") b.withdrawn += amt;
    else if (r.type === "EXPENSE") b.expenses += amt;
    else if (r.type === "DEPOSIT_TO_TREASURY") b.depositedToTreasury += amt;
  }
  for (const b of map.values()) {
    b.invested = round2(b.invested);
    b.withdrawn = round2(b.withdrawn);
    b.expenses = round2(b.expenses);
    b.depositedToTreasury = round2(b.depositedToTreasury);
    b.netCapital = round2(b.invested - b.withdrawn);
    // What's left of their invested capital that hasn't gone to an expense yet
    // — the exact "koto taka খরচ হয়েছে, koto taka এখনও খরচ হয়নি" question.
    // Expenses can be entered as one lump sum or many small entries across
    // different categories; both are just PartnerTxn rows, summed the same way.
    b.remaining = round2(b.invested - b.expenses);
  }
  return map;
}

export type BusinessCapitalSummary = {
  totalInvested: number;
  totalExpenses: number;
  totalRemaining: number; // totalInvested − totalExpenses, across every partner
};

/** Whole-business rollup: who invested what, in aggregate, and what's left unspent. */
export async function businessCapitalSummary(
  workspaceId: string,
): Promise<BusinessCapitalSummary> {
  const balances = await partnerBalances(workspaceId);
  let totalInvested = 0;
  let totalExpenses = 0;
  for (const b of balances.values()) {
    totalInvested += b.invested;
    totalExpenses += b.expenses;
  }
  return {
    totalInvested: round2(totalInvested),
    totalExpenses: round2(totalExpenses),
    totalRemaining: round2(totalInvested - totalExpenses),
  };
}

/** Central treasury running balance = sum(IN) − sum(OUT). */
export async function treasuryBalance(workspaceId: string): Promise<number> {
  const rows = await prisma.treasuryEntry.groupBy({
    by: ["type"],
    where: { workspaceId },
    _sum: { amount: true },
  });
  let bal = 0;
  for (const r of rows) {
    const amt = Number(r._sum.amount ?? 0);
    bal += r.type === "IN" ? amt : -amt;
  }
  return round2(bal);
}

/** Total business net profit across all non-cancelled orders (returns-aware). */
export async function totalBusinessProfit(workspaceId: string): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { workspaceId, status: { not: "CANCELLED" } },
    include: { items: { include: { returns: true } } },
  });
  const total = orders.reduce((s, o) => s + computeOrderTotals(o).netProfit, 0);
  return round2(total);
}

export type OverdueOrder = {
  orderId: string;
  date: string;
  daysOverdue: number;
  amount: number;
  customerName: string;
  heldByName: string | null;
};

/** Orders unpaid/partial and older than `days`, with who holds the cash. */
export async function overdueOrders(
  workspaceId: string,
  days = OVERDUE_DAYS,
): Promise<OverdueOrder[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const orders = await prisma.order.findMany({
    where: {
      workspaceId,
      status: { not: "CANCELLED" },
      paymentStatus: { in: ["UNPAID", "PARTIAL"] },
      date: { lt: cutoff },
    },
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
      heldBy: { include: { user: { select: { name: true, email: true } } } },
    },
    orderBy: { date: "asc" },
  });

  const now = Date.now();
  return orders.map((o) => ({
    orderId: o.id,
    date: o.date.toISOString().slice(0, 10),
    daysOverdue: Math.floor((now - o.date.getTime()) / 86_400_000),
    amount: computeOrderTotals(o).customerTotal,
    customerName: o.customer?.name ?? "Walk-in",
    heldByName: o.heldBy ? (o.heldBy.user.name ?? o.heldBy.user.email) : null,
  }));
}

/** Reconcile OVERDUE_PAYMENT notifications with the current overdue set. */
export async function refreshOverdueAlerts(
  workspaceId: string,
): Promise<OverdueOrder[]> {
  const overdue = await overdueOrders(workspaceId);
  const liveKeys = overdue.map((o) => `overdue:${o.orderId}`);

  await prisma.$transaction([
    ...overdue.map((o) =>
      prisma.notification.upsert({
        where: {
          workspaceId_dedupeKey: { workspaceId, dedupeKey: `overdue:${o.orderId}` },
        },
        create: {
          workspaceId,
          type: "OVERDUE_PAYMENT",
          message: `Overdue: ${o.customerName} owes ${o.amount.toFixed(2)} (${o.daysOverdue}d)${o.heldByName ? ` — held by ${o.heldByName}` : ""}`,
          dedupeKey: `overdue:${o.orderId}`,
        },
        update: {
          message: `Overdue: ${o.customerName} owes ${o.amount.toFixed(2)} (${o.daysOverdue}d)${o.heldByName ? ` — held by ${o.heldByName}` : ""}`,
        },
      }),
    ),
    prisma.notification.deleteMany({
      where: {
        workspaceId,
        type: "OVERDUE_PAYMENT",
        dedupeKey: { notIn: liveKeys.length ? liveKeys : ["__none__"] },
      },
    }),
  ]);

  return overdue;
}
