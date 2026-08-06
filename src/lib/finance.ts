import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cancelledOrderCost, computeOrderTotals } from "@/lib/orders";
import { amortizeAll } from "@/lib/amortize";

export const OVERDUE_DAYS = 7;

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

export type PartnerBalance = {
  partnerId: string;
  invested: number; // sum of INVESTMENT
  withdrawn: number; // sum of WITHDRAWAL, both kinds below
  /**
   * Withdrawals that took capital back out — anything not part of a profit
   * distribution. This is money the partner no longer has in the business.
   */
  capitalWithdrawn: number;
  /**
   * Withdrawals that were a share of profit (distribution-linked). Taking
   * profit doesn't reduce what you have invested, so this is tracked apart.
   */
  profitWithdrawn: number;
  customerProductSpend: number; // Purchase (inventory to resell) rows tagged to this partner
  internalPurchaseSpend: number; // InternalPurchase rows tagged to this partner
  boostSpend: number; // BoostDailySpend rows tagged to this partner (ad money from their own pocket)
  miscExpense: number; // manual PartnerTxn EXPENSE entries — rent, food, anything with no dedicated record
  expenses: number; // customerProductSpend + internalPurchaseSpend + boostSpend + miscExpense
  depositedToTreasury: number; // sum of DEPOSIT_TO_TREASURY
  netCapital: number; // invested − capitalWithdrawn
  remaining: number; // netCapital − expenses: what's left of their capital still to spend
};

/**
 * Derive each partner's balances — never stored, always computed from the
 * underlying records. `expenses` is auto-summed from three real sources —
 * Purchase and InternalPurchase rows tagged with `paidByPartnerId`, plus
 * manual PartnerTxn EXPENSE entries for anything with no dedicated record.
 *
 * Withdrawals are split by what they took. Taking a share of profit leaves
 * your capital where it is; taking capital back does not, and only the second
 * belongs in "net capital" and "remaining". Both were previously ignored by
 * `remaining` and both treated alike by `netCapital`, so a partner could
 * withdraw their capital and the page would go on reporting it as still
 * invested and still available to spend. `distributionId` is what tells them
 * apart — a distribution sets it, a hand-entered withdrawal doesn't.
 */
export async function partnerBalances(
  workspaceId: string,
): Promise<Map<string, PartnerBalance>> {
  const [txnRows, capitalOutRows, purchaseRows, internalRows, boostRows] = await Promise.all([
    prisma.partnerTxn.groupBy({
      by: ["partnerId", "type"],
      where: { workspaceId },
      _sum: { amount: true },
    }),
    // Withdrawals with no distribution behind them: capital coming back out.
    prisma.partnerTxn.groupBy({
      by: ["partnerId"],
      where: { workspaceId, type: "WITHDRAWAL", distributionId: null },
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
    prisma.boostDailySpend.groupBy({
      by: ["paidByPartnerId"],
      where: { workspaceId, paidByPartnerId: { not: null } },
      _sum: { amount: true },
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
        capitalWithdrawn: 0,
        profitWithdrawn: 0,
        customerProductSpend: 0,
        internalPurchaseSpend: 0,
        boostSpend: 0,
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
  for (const r of capitalOutRows) {
    ensure(r.partnerId).capitalWithdrawn += Number(r._sum.amount ?? 0);
  }
  for (const p of purchaseRows) {
    const b = ensure(p.paidByPartnerId!);
    b.customerProductSpend += Number(p.unitCost) * p.quantity;
  }
  for (const ip of internalRows) {
    const b = ensure(ip.paidByPartnerId!);
    b.internalPurchaseSpend += Number(ip.cost) * ip.quantity;
  }
  for (const bs of boostRows) {
    const b = ensure(bs.paidByPartnerId!);
    b.boostSpend += Number(bs._sum.amount ?? 0);
  }

  for (const b of map.values()) {
    b.invested = round2(b.invested);
    b.withdrawn = round2(b.withdrawn);
    b.customerProductSpend = round2(b.customerProductSpend);
    b.internalPurchaseSpend = round2(b.internalPurchaseSpend);
    b.boostSpend = round2(b.boostSpend);
    b.miscExpense = round2(b.miscExpense);
    b.expenses = round2(
      b.customerProductSpend + b.internalPurchaseSpend + b.boostSpend + b.miscExpense,
    );
    b.depositedToTreasury = round2(b.depositedToTreasury);
    b.capitalWithdrawn = round2(b.capitalWithdrawn);
    b.profitWithdrawn = round2(b.withdrawn - b.capitalWithdrawn);
    b.netCapital = round2(b.invested - b.capitalWithdrawn);
    b.remaining = round2(b.netCapital - b.expenses);
  }
  return map;
}

export type BusinessCapitalSummary = {
  /** Everything the partners ever put in, before anything came back out. */
  totalInvested: number;
  /** Capital taken back out — profit distributions aren't counted here. */
  totalCapitalWithdrawn: number;
  /** totalInvested − totalCapitalWithdrawn: what's actually still in. */
  netInvested: number;
  customerProductSpend: number; // ALL purchases in the workspace, tagged or not
  internalPurchaseSpend: number; // ALL internal purchases in the workspace, tagged or not
  boostSpend: number; // ALL boost daily spends, whatever funded them
  miscExpense: number; // ALL partner EXPENSE entries
  totalExpenses: number;
  /**
   * The part of that spending paid for out of the shared treasury rather than
   * a partner's pocket. Shared money is the business's own — mostly sales
   * takings — so spending it uses up no partner's capital.
   */
  treasuryFundedSpend: number;
  /** totalExpenses − treasuryFundedSpend: what partner capital actually paid for. */
  capitalSpend: number;
  totalRemaining: number; // netInvested − capitalSpend
};

/**
 * Whole-business rollup: what the partners put in, what's still in, and what's
 * left of it once the spending is accounted for.
 *
 * The spend figures count EVERY purchase regardless of whether anyone recorded
 * who paid, so the business total never silently drops spending just because a
 * row went untagged. "Remaining" is a different question though, and it used to
 * be answered with the same number: capital minus ALL spending, including
 * anything bought from the treasury. That was harmless while every purchase was
 * partner-funded, and wrong the moment one wasn't — the first treasury-funded
 * purchase would have shown the partners as overdrawn by its full amount,
 * having spent nothing.
 *
 * So treasury-funded spending is separated out. An untagged row still counts
 * against capital: nobody recording a payer is far more likely to mean a
 * partner paid and forgot than that the treasury did, and the treasury leaves
 * its own trail either way.
 */
export async function businessCapitalSummary(
  workspaceId: string,
): Promise<BusinessCapitalSummary> {
  const [balances, purchases, internalPurchases, miscRows, boostRows, treasuryBoost] =
    await Promise.all([
      partnerBalances(workspaceId),
      prisma.purchase.findMany({
        where: { workspaceId },
        select: { unitCost: true, quantity: true, paidFromTreasury: true },
      }),
      prisma.internalPurchase.findMany({
        where: { workspaceId },
        select: { cost: true, quantity: true, paidFromTreasury: true },
      }),
      prisma.partnerTxn.aggregate({
        where: { workspaceId, type: "EXPENSE" },
        _sum: { amount: true },
      }),
      prisma.boostDailySpend.aggregate({
        where: { workspaceId },
        _sum: { amount: true },
      }),
      prisma.boostDailySpend.aggregate({
        where: { workspaceId, paidFromTreasury: true },
        _sum: { amount: true },
      }),
    ]);

  let totalInvested = 0;
  let totalCapitalWithdrawn = 0;
  for (const b of balances.values()) {
    totalInvested += b.invested;
    totalCapitalWithdrawn += b.capitalWithdrawn;
  }
  // What's still in. Summing `invested` alone would go on reporting money a
  // partner has already taken back as though it were still funding the shop.
  const netInvested = totalInvested - totalCapitalWithdrawn;

  const customerProductSpend = purchases.reduce(
    (s, p) => s + Number(p.unitCost) * p.quantity,
    0,
  );
  const internalPurchaseSpend = internalPurchases.reduce(
    (s, ip) => s + Number(ip.cost) * ip.quantity,
    0,
  );
  const miscExpense = Number(miscRows._sum.amount ?? 0);
  const boostSpend = Number(boostRows._sum.amount ?? 0);
  const totalExpenses = customerProductSpend + internalPurchaseSpend + boostSpend + miscExpense;

  // Paid for out of the shared pot. A manual PartnerTxn EXPENSE is a partner's
  // own money by definition, so it never appears here.
  const treasuryFundedSpend =
    purchases
      .filter((p) => p.paidFromTreasury)
      .reduce((s, p) => s + Number(p.unitCost) * p.quantity, 0) +
    internalPurchases
      .filter((ip) => ip.paidFromTreasury)
      .reduce((s, ip) => s + Number(ip.cost) * ip.quantity, 0) +
    Number(treasuryBoost._sum.amount ?? 0);
  const capitalSpend = totalExpenses - treasuryFundedSpend;

  return {
    totalInvested: round2(totalInvested),
    totalCapitalWithdrawn: round2(totalCapitalWithdrawn),
    netInvested: round2(netInvested),
    customerProductSpend: round2(customerProductSpend),
    internalPurchaseSpend: round2(internalPurchaseSpend),
    boostSpend: round2(boostSpend),
    miscExpense: round2(miscExpense),
    totalExpenses: round2(totalExpenses),
    treasuryFundedSpend: round2(treasuryFundedSpend),
    capitalSpend: round2(capitalSpend),
    totalRemaining: round2(netInvested - capitalSpend),
  };
}

/**
 * Central treasury running balance = sum(IN) − sum(OUT).
 *
 * Pass a transaction client when the balance is about to be spent against.
 * Reading it outside the transaction that then writes leaves a gap two people
 * can both walk through: each sees 10,000, each takes 8,000, and the treasury
 * ends at −6,000 with nothing to have stopped it. Inside the transaction the
 * read and the write are one step.
 */
export async function treasuryBalance(
  workspaceId: string,
  client: Pick<Prisma.TransactionClient, "treasuryEntry"> = prisma,
): Promise<number> {
  const rows = await client.treasuryEntry.groupBy({
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

/** Thrown inside a transaction to roll it back with a message for the user. */
export class InsufficientTreasury extends Error {
  constructor(available: number, need: number) {
    super(
      `Treasury balance is insufficient — available ${available.toFixed(2)}, need ${need.toFixed(2)}`,
    );
    this.name = "InsufficientTreasury";
  }
}

/**
 * Check the treasury can cover `need` and roll the transaction back if not.
 * `creditBack` is an amount already deducted by the row being edited — that
 * money is being replaced, not spent a second time.
 */
export async function assertTreasuryCovers(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  need: number,
  creditBack = 0,
): Promise<void> {
  const available = round2((await treasuryBalance(workspaceId, tx)) + creditBack);
  if (available < need) throw new InsufficientTreasury(available, need);
}

/** What one written-off piece cost: last purchase, else catalogue, else zero. */
function writeOffUnitCost(a: {
  productVariant: { unitCost: unknown; purchases: { unitCost: unknown }[] };
}): number {
  const lastPurchase = a.productVariant.purchases[0];
  if (lastPurchase) return Number(lastPurchase.unitCost);
  return a.productVariant.unitCost != null ? Number(a.productVariant.unitCost) : 0;
}

export type BusinessProfit = {
  /** Order profit, returns-aware, less what cancelled orders cost. */
  tradingProfit: number;
  /** Advertising — every BoostDailySpend, whoever funded it. */
  adSpend: number;
  /**
   * Internal purchases charged to this period. A purchase with spreadMonths
   * set contributes only the part that has elapsed; the rest is `prepaid`.
   */
  internalPurchaseSpend: number;
  /** Manual partner EXPENSE entries — anything with no dedicated record. */
  miscExpense: number;
  /** Stock written off as damaged or lost, valued at what it cost to buy. */
  stockLoss: number;
  /**
   * Spread costs paid for but not yet charged to any period — a year of
   * hosting with eight months left to run.
   *
   * Shown beside profit, never inside it. The cash for this is already gone,
   * so a healthier-looking profit must not read as money available to take
   * out; this line is what says so.
   */
  prepaidExpenses: number;
  operatingExpenses: number;
  /** tradingProfit − operatingExpenses. What profit shares are paid on. */
  netProfit: number;
};

/**
 * What the business actually made.
 *
 * Two layers, and the difference between them matters. `tradingProfit` is what
 * the orders themselves earned — returns applied, and cancelled orders costing
 * their packaging, gifts and courier return charges rather than being free.
 * `netProfit` then pays for running the shop: the ads, every internal purchase
 * and the odd rent entry. No category is treated specially — a cost is charged
 * to the period it was paid in, whether that's a month of Facebook ads, a
 * year of hosting or a box of polybags. Simple to explain and simple to check,
 * which for a shop this size is worth more than smoothing each cost over the
 * months it will actually be used in.
 *
 * Only the first layer used to exist, under the name "total business profit",
 * and partner profit shares were calculated from it. That handed out a share
 * of money the ads had already spent — the exact failure the cancelled-order
 * fix was made to prevent, one level up. Shares are paid on `netProfit` now.
 *
 * The breakdown is returned in full rather than as one "expenses" figure, so
 * a partner asking why their share moved can read the reason instead of
 * taking the total on trust.
 */
export async function totalBusinessProfit(workspaceId: string): Promise<BusinessProfit> {
  const [orders, adSpendAgg, internalPurchases, miscAgg, writeOffs] = await Promise.all([
    prisma.order.findMany({
      where: { workspaceId },
      include: { items: { include: { returns: true } } },
    }),
    prisma.boostDailySpend.aggregate({ where: { workspaceId }, _sum: { amount: true } }),
    prisma.internalPurchase.findMany({
      where: { workspaceId },
      select: { cost: true, quantity: true, date: true, spreadMonths: true },
    }),
    prisma.partnerTxn.aggregate({
      where: { workspaceId, type: "EXPENSE" },
      _sum: { amount: true },
    }),
    // Stock that left without being sold. It was bought with real money and it
    // is never coming back, but nothing recognised it as a loss: profit only
    // ever sees cost when something sells, so a broken box simply vanished
    // from the shelf and from the accounts at the same time.
    prisma.stockAdjustment.findMany({
      where: { workspaceId, type: { in: ["DAMAGED", "LOST"] } },
      select: {
        delta: true,
        productVariant: {
          select: {
            unitCost: true,
            // Same cost chain a sale uses: what it last cost to buy, then the
            // catalogue price, then nothing. Valuing a write-off only by the
            // catalogue cost would report zero loss for every variant that was
            // bought but never priced — which is most of them, since the
            // purchase form is where the real cost gets typed.
            purchases: { orderBy: { date: "desc" }, take: 1, select: { unitCost: true } },
          },
        },
      },
    }),
  ]);

  const tradingProfit = orders.reduce(
    (s, o) =>
      s +
      (o.status === "CANCELLED"
        ? -cancelledOrderCost(o).total
        : computeOrderTotals(o).netProfit),
    0,
  );
  const adSpend = Number(adSpendAgg._sum.amount ?? 0);
  // A spread purchase contributes only its elapsed share; the remainder comes
  // back as `prepaid` rather than disappearing.
  const internal = amortizeAll(
    internalPurchases.map((ip) => ({
      date: ip.date,
      amount: Number(ip.cost) * ip.quantity,
      spreadMonths: ip.spreadMonths,
    })),
    null,
  );
  const internalPurchaseSpend = internal.recognized;
  const miscExpense = Number(miscAgg._sum.amount ?? 0);
  const stockLoss = writeOffs.reduce((s, a) => s + Math.abs(Math.min(0, a.delta)) * writeOffUnitCost(a), 0);
  const operatingExpenses = adSpend + internalPurchaseSpend + miscExpense + stockLoss;

  return {
    tradingProfit: round2(tradingProfit),
    adSpend: round2(adSpend),
    internalPurchaseSpend: round2(internalPurchaseSpend),
    miscExpense: round2(miscExpense),
    stockLoss: round2(stockLoss),
    prepaidExpenses: internal.prepaid,
    operatingExpenses: round2(operatingExpenses),
    netProfit: round2(tradingProfit - operatingExpenses),
  };
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
  const [overdue, ws] = await Promise.all([
    overdueOrders(workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
  ]);
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
          link: ws ? `/${ws.slug}/sales/orders/${o.orderId}/invoice` : null,
          dedupeKey: `overdue:${o.orderId}`,
        },
        update: {
          message: `Overdue: ${o.customerName} owes ${o.amount.toFixed(2)} (${o.daysOverdue}d)${o.heldByName ? ` — held by ${o.heldByName}` : ""}`,
          link: ws ? `/${ws.slug}/sales/orders/${o.orderId}/invoice` : null,
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
