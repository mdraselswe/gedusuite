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
  }
  return map;
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
