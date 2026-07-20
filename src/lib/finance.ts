import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";

export const OVERDUE_DAYS = 7;

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type PartnerBalance = {
  partnerId: string;
  invested: number; // sum of INVESTMENT
  withdrawn: number; // sum of WITHDRAWAL
  customerProductSpend: number; // Purchase (inventory to resell) rows tagged to this partner
  internalPurchaseSpend: number; // InternalPurchase rows tagged to this partner
  miscExpense: number; // manual PartnerTxn EXPENSE entries — rent, food, anything with no dedicated record
  expenses: number; // customerProductSpend + internalPurchaseSpend + miscExpense
  depositedToTreasury: number; // sum of DEPOSIT_TO_TREASURY
  netCapital: number; // invested − withdrawn
  remaining: number; // invested − expenses: what's left of their capital still to spend
};

/**
 * Derive each partner's balances — never stored, always computed from the
 * underlying records. `expenses` is no longer a single manually-typed number:
 * it's auto-summed from three real sources — Purchase and InternalPurchase
 * rows tagged with `paidByPartnerId`, plus manual PartnerTxn EXPENSE entries
 * for anything with no dedicated record (rent, food, misc).
 */
export async function partnerBalances(
  workspaceId: string,
): Promise<Map<string, PartnerBalance>> {
  const [txnRows, purchaseRows, internalRows] = await Promise.all([
    prisma.partnerTxn.groupBy({
      by: ["partnerId", "type"],
      where: { workspaceId },
      _sum: { amount: true },
    }),
    prisma.purchase.findMany({
      where: { workspaceId, paidByPartnerId: { not: null } },
      select: { paidByPartnerId: true, unitCost: true, quantity: true },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId, paidByPartnerId: { not: null } },
      select: { paidByPartnerId: true, cost: true, quantity: true },
    }),
  ]);

  const map = new Map<string, PartnerBalance>();
  const ensure = (id: string): PartnerBalance =>
    map.get(id) ??
    map
      .set(id, {
        partnerId: id,
        invested: 0,
        withdrawn: 0,
        customerProductSpend: 0,
        internalPurchaseSpend: 0,
        miscExpense: 0,
        expenses: 0,
        depositedToTreasury: 0,
        netCapital: 0,
        remaining: 0,
      })
      .get(id)!;

  for (const r of txnRows) {
    const b = ensure(r.partnerId);
    const amt = Number(r._sum.amount ?? 0);
    if (r.type === "INVESTMENT") b.invested += amt;
    else if (r.type === "WITHDRAWAL") b.withdrawn += amt;
    else if (r.type === "EXPENSE") b.miscExpense += amt;
    else if (r.type === "DEPOSIT_TO_TREASURY") b.depositedToTreasury += amt;
  }
  for (const p of purchaseRows) {
    const b = ensure(p.paidByPartnerId!);
    b.customerProductSpend += Number(p.unitCost) * p.quantity;
  }
  for (const ip of internalRows) {
    const b = ensure(ip.paidByPartnerId!);
    b.internalPurchaseSpend += Number(ip.cost) * ip.quantity;
  }

  for (const b of map.values()) {
    b.invested = round2(b.invested);
    b.withdrawn = round2(b.withdrawn);
    b.customerProductSpend = round2(b.customerProductSpend);
    b.internalPurchaseSpend = round2(b.internalPurchaseSpend);
    b.miscExpense = round2(b.miscExpense);
    b.expenses = round2(b.customerProductSpend + b.internalPurchaseSpend + b.miscExpense);
    b.depositedToTreasury = round2(b.depositedToTreasury);
    b.netCapital = round2(b.invested - b.withdrawn);
    b.remaining = round2(b.invested - b.expenses);
  }
  return map;
}

export type BusinessCapitalSummary = {
  totalInvested: number;
  customerProductSpend: number; // ALL purchases in the workspace, tagged or not
  internalPurchaseSpend: number; // ALL internal purchases in the workspace, tagged or not
  miscExpense: number; // ALL partner EXPENSE entries
  totalExpenses: number;
  totalRemaining: number; // totalInvested − totalExpenses
};

/**
 * Whole-business rollup: total invested (every partner) vs. total actually
 * spent — on customer-product purchases, internal purchases, and misc
 * (rent/food/etc.) — with what's left unspent. Unlike the per-partner view,
 * this counts EVERY purchase/internal-purchase regardless of whether it was
 * tagged to a specific partner, so the business total never silently drops
 * spending just because nobody recorded who paid for it.
 */
export async function businessCapitalSummary(
  workspaceId: string,
): Promise<BusinessCapitalSummary> {
  const [balances, purchases, internalPurchases, miscRows] = await Promise.all([
    partnerBalances(workspaceId),
    prisma.purchase.findMany({
      where: { workspaceId },
      select: { unitCost: true, quantity: true },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId },
      select: { cost: true, quantity: true },
    }),
    prisma.partnerTxn.aggregate({
      where: { workspaceId, type: "EXPENSE" },
      _sum: { amount: true },
    }),
  ]);

  let totalInvested = 0;
  for (const b of balances.values()) totalInvested += b.invested;

  const customerProductSpend = purchases.reduce(
    (s, p) => s + Number(p.unitCost) * p.quantity,
    0,
  );
  const internalPurchaseSpend = internalPurchases.reduce(
    (s, ip) => s + Number(ip.cost) * ip.quantity,
    0,
  );
  const miscExpense = Number(miscRows._sum.amount ?? 0);
  const totalExpenses = customerProductSpend + internalPurchaseSpend + miscExpense;

  return {
    totalInvested: round2(totalInvested),
    customerProductSpend: round2(customerProductSpend),
    internalPurchaseSpend: round2(internalPurchaseSpend),
    miscExpense: round2(miscExpense),
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

export type HeldCash = {
  membershipId: string;
  holderName: string;
  amount: number;
  orderCount: number;
};

/**
 * How much uncollected sales cash is currently sitting with each team member
 * — every UNPAID/PARTIAL order tagged with a holder, not just the ones old
 * enough to count as "overdue". Answers "who's holding how much right now"
 * before it becomes a 7-day-overdue problem.
 */
export async function cashHeldByMember(workspaceId: string): Promise<HeldCash[]> {
  const orders = await prisma.order.findMany({
    where: {
      workspaceId,
      status: { not: "CANCELLED" },
      paymentStatus: { in: ["UNPAID", "PARTIAL"] },
      heldByMembershipId: { not: null },
    },
    include: {
      items: { include: { returns: true } },
      heldBy: { include: { user: { select: { name: true, email: true } } } },
    },
  });

  const map = new Map<string, HeldCash>();
  for (const o of orders) {
    if (!o.heldByMembershipId || !o.heldBy) continue;
    const amount = computeOrderTotals(o).customerTotal;
    const existing = map.get(o.heldByMembershipId);
    if (existing) {
      existing.amount = round2(existing.amount + amount);
      existing.orderCount += 1;
    } else {
      map.set(o.heldByMembershipId, {
        membershipId: o.heldByMembershipId,
        holderName: o.heldBy.user.name ?? o.heldBy.user.email,
        amount: round2(amount),
        orderCount: 1,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/** Total the customer still owes, across every non-cancelled UNPAID/PARTIAL order. */
export async function totalDue(workspaceId: string): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { workspaceId, status: { not: "CANCELLED" }, paymentStatus: { in: ["UNPAID", "PARTIAL"] } },
    include: { items: { include: { returns: true } } },
  });
  return round2(orders.reduce((s, o) => s + computeOrderTotals(o).customerTotal, 0));
}

export type PaidNotDeposited = {
  orderId: string;
  date: string;
  customerName: string;
  amount: number;
  paymentMethod: string;
  heldByName: string | null;
  isCourierCollection: boolean;
};

/**
 * Orders where the customer HAS paid, but that cash hasn't been confirmed as
 * deposited into the shared treasury yet — i.e. it's still physically either
 * (a) with the courier company (COURIER_COLLECTION — they collected it from
 * the customer and haven't remitted it back yet), or (b) with whichever team
 * member collected it directly (CASH/BKASH/NAGAD/self-delivery). Paying and
 * "money safely in the business" are NOT the same event — this is the gap
 * between them. Cleared by markCashDeposited() once confirmed.
 */
export async function paidNotDeposited(workspaceId: string): Promise<PaidNotDeposited[]> {
  const orders = await prisma.order.findMany({
    where: {
      workspaceId,
      status: { not: "CANCELLED" },
      paymentStatus: "PAID",
      cashInTreasury: false,
    },
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
      heldBy: { include: { user: { select: { name: true, email: true } } } },
    },
    orderBy: { date: "asc" },
  });
  return orders.map((o) => ({
    orderId: o.id,
    date: o.date.toISOString().slice(0, 10),
    customerName: o.customer?.name ?? "Walk-in",
    amount: computeOrderTotals(o).customerTotal,
    paymentMethod: o.paymentMethod,
    heldByName: o.heldBy ? (o.heldBy.user.name ?? o.heldBy.user.email) : null,
    isCourierCollection: o.paymentMethod === "COURIER_COLLECTION",
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
