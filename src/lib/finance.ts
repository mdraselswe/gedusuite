import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals, orderNetProfit } from "@/lib/orders";
import { amountOutstanding, depositAmount, deliveryCostCharged } from "@/lib/order-cash";
import { inventoryValue } from "@/lib/inventory";
import { amortizeAll } from "@/lib/amortize";
import { splitByShare } from "@/lib/profit-share";
import { dhakaRecordStamp, type DhakaStamp } from "@/lib/dhaka-time";

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
  /** Capital taken back out of the treasury — the subset of capitalWithdrawn that moved the pot. */
  treasuryCapitalWithdrawn: number;
  /**
   * Their share of the treasury spending that used up partner deposits, split
   * by what each partner has left in the pot rather than by profit share.
   *
   * Pooled cash carries no name, but a capital account isn't about which note
   * left — it's about whose claim shrinks. Sharing it by profit percent would
   * charge a partner who deposited nothing, and would make the same purchase
   * cost different amounts depending on whether the money went via the treasury
   * or straight to the supplier. By deposit, the two routes agree.
   */
  treasuryCapitalSpend: number;
  netCapital: number; // invested + depositedToTreasury − capitalWithdrawn
  /** netCapital − expenses − treasuryCapitalSpend: what's left of their capital to spend. */
  remaining: number;
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
 *
 * Cash handed to the treasury counts as capital in just as much as cash spent
 * straight out of a pocket does. It didn't, and the two routes to putting the
 * same money into the same business gave different answers: pay the supplier
 * yourself and your capital rose by what you paid, hand the money over and let
 * the treasury pay and your capital didn't move at all.
 */
export async function partnerBalances(
  workspaceId: string,
): Promise<Map<string, PartnerBalance>> {
  const [
    txnRows,
    capitalOutRows,
    treasuryOutRows,
    purchaseRows,
    internalRows,
    boostRows,
    treasuryPurchases,
    treasuryInternals,
    treasuryBoost,
  ] = await Promise.all([
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
    // The subset of those that came out of the treasury — a linked entry is
    // what says the pot actually moved. Cash a partner was holding elsewhere
    // leaves the pot alone and so leaves everyone's share of it alone.
    prisma.partnerTxn.groupBy({
      by: ["partnerId"],
      where: {
        workspaceId,
        type: "WITHDRAWAL",
        distributionId: null,
        treasuryEntry: { isNot: null },
      },
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
    // Everything the treasury paid for. Read again here rather than handed down
    // from businessCapitalSummary: the partner pages call this function on its
    // own, and a balance that only came out right when the rollup happened to
    // be running alongside it would be worse than the extra three queries.
    prisma.purchase.findMany({
      where: { workspaceId, paidFromTreasury: true },
      select: { unitCost: true, quantity: true },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId, paidFromTreasury: true },
      select: { cost: true, quantity: true },
    }),
    prisma.boostDailySpend.aggregate({
      where: { workspaceId, paidFromTreasury: true },
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
        treasuryCapitalWithdrawn: 0,
        treasuryCapitalSpend: 0,
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
  for (const r of treasuryOutRows) {
    ensure(r.partnerId).treasuryCapitalWithdrawn += Number(r._sum.amount ?? 0);
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
    b.treasuryCapitalWithdrawn = round2(b.treasuryCapitalWithdrawn);
    b.profitWithdrawn = round2(b.withdrawn - b.capitalWithdrawn);
    b.netCapital = round2(b.invested + b.depositedToTreasury - b.capitalWithdrawn);
  }

  // Second pass, because sharing the treasury's spending out needs every
  // partner's stake in the pot before any one of them can be told their part.
  const treasuryFundedSpend =
    treasuryPurchases.reduce((s, p) => s + Number(p.unitCost) * p.quantity, 0) +
    treasuryInternals.reduce((s, ip) => s + Number(ip.cost) * ip.quantity, 0) +
    Number(treasuryBoost._sum.amount ?? 0);
  const stakes = [...map.values()].map((b) => ({
    partnerId: b.partnerId,
    // Weight, not money: what each partner still has in the pot. A partner who
    // has taken more out of the treasury than they put in weighs nothing rather
    // than negatively — they aren't funding anyone else's purchases.
    percent: Math.max(0, b.depositedToTreasury - b.treasuryCapitalWithdrawn),
  }));
  // The pot's partner-funded part: each stake floored on its own before they
  // are added up, never netted across people. A partner taking capital out of
  // the treasury is almost always taking sales cash — their own capital went
  // into stock months ago — so netting it would have one partner's withdrawal
  // eat another's deposit, and the depositor's money would then never finish
  // being spent however much the treasury bought.
  const pool = stakes.reduce((s, x) => s + x.percent, 0);
  // splitByShare normalizes the weights and hands the rounding remainder to the
  // biggest one, so the shares add up to exactly what was consumed.
  for (const cut of splitByShare(stakes, Math.min(treasuryFundedSpend, pool))) {
    map.get(cut.partnerId)!.treasuryCapitalSpend = cut.amount;
  }
  for (const b of map.values()) {
    b.remaining = round2(b.netCapital - b.expenses - b.treasuryCapitalSpend);
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
   * a partner's pocket.
   */
  treasuryFundedSpend: number;
  /**
   * Partner capital currently sitting in the treasury: what partners have
   * deposited, less any capital they've taken back out of it. Profit
   * distributions aren't in here — those hand out earnings, not capital.
   */
  partnerCashInTreasury: number;
  /**
   * The slice of treasuryFundedSpend the shop's own takings paid for, once the
   * partner money in the pot has been used up. This is the only spending that
   * costs nobody any capital.
   *
   * treasuryFundedSpend used to fill that role by itself, on the reasoning that
   * treasury money is the business's own. True while the pot only ever held
   * sales takings, and wrong as soon as a partner deposited capital into it:
   * the same taka was then counted twice over, once as capital nobody had spent
   * yet and again as the stock it had already bought.
   */
  salesFundedSpend: number;
  /**
   * Bought on account and not paid for yet — what the shop owes its suppliers.
   *
   * Not a cost that has been borne, so it takes no capital and leaves no
   * treasury entry; it is a debt, and until this existed it was invisible.
   * Stock taken on terms was read as spent partner capital, and the money set
   * aside to settle the bill looked like profit anyone could take out.
   */
  supplierDue: number;
  /** totalExpenses − salesFundedSpend − supplierDue: what capital paid for. */
  capitalSpend: number;
  totalRemaining: number; // netInvested − capitalSpend
  /** Unsold stock at what it cost — spent capital that is still an asset. */
  inventoryValue: number;
  /** Pieces on the shelf behind that figure. */
  inventoryUnits: number;
  /** Cash in the shared pot right now — sales takings and partner deposits alike. */
  treasuryBalance: number;
  /**
   * The slice of inventoryValue that came from hand-entered positive stock
   * corrections rather than purchases — see InventoryValue.fromCorrections.
   */
  inventoryFromCorrections: number;
  /**
   * treasuryBalance + inventoryValue − supplierDue: what the business actually
   * holds, cash and goods together, less what it owes for them.
   *
   * An asset question, deliberately, where everything above it is a capital
   * one. This used to be totalRemaining + inventoryValue, which mixed the two
   * and so answered neither: the treasury didn't appear in it at all, and
   * selling stock therefore made the figure fall — the goods left the shelf,
   * the money that replaced them landed somewhere the sum couldn't see, and a
   * shop trading profitably watched its headline number sink.
   *
   * Cash still out with couriers or owed by customers isn't in here either.
   * It's real, and it belongs to the business, but it isn't held yet — the
   * treasury and the "not deposited" list on the dashboard are where that
   * money is tracked until it arrives.
   */
  businessHoldings: number;
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
 * So treasury-funded spending is separated out — but only as far as the pot is
 * the shop's own money. Partner deposits go into the same pot, and spending
 * those is spending capital wherever the taka physically travelled: hand over
 * 10,000, let the treasury buy 6,110 of stock, and the shop is 6,110 of capital
 * down and 6,110 of stock up, exactly as if the partner had paid the supplier
 * directly. Treated as capital-neutral, the two routes disagreed by the whole
 * purchase — same money in, same goods on the shelf, 6,110 of difference in
 * what the partners were told they still had.
 *
 * An untagged row still counts against capital: nobody recording a payer is far
 * more likely to mean a partner paid and forgot than that the treasury did, and
 * the treasury leaves its own trail either way.
 */
export async function businessCapitalSummary(
  workspaceId: string,
): Promise<BusinessCapitalSummary> {
  const [
    balances,
    purchases,
    internalPurchases,
    miscRows,
    boostRows,
    treasuryBoost,
    stock,
    treasury,
  ] = await Promise.all([
    partnerBalances(workspaceId),
    prisma.purchase.findMany({
      where: { workspaceId },
      select: { unitCost: true, quantity: true, paidFromTreasury: true, onCredit: true },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId },
      select: { cost: true, quantity: true, paidFromTreasury: true, onCredit: true },
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
    // The asset side of all that purchasing — see businessHoldings.
    inventoryValue(workspaceId),
    treasuryBalance(workspaceId),
  ]);

  let totalInvested = 0;
  let totalCapitalWithdrawn = 0;
  // The pot's partner-funded part, stake by stake — the same sum partnerBalances
  // shares out, so the table and this card can't disagree about how much of the
  // treasury is capital.
  let partnerCashInTreasury = 0;
  for (const b of balances.values()) {
    // Both routes into the business, added together: money a partner spent
    // straight from their pocket, and money they handed to the treasury.
    totalInvested += b.invested + b.depositedToTreasury;
    totalCapitalWithdrawn += b.capitalWithdrawn;
    partnerCashInTreasury += Math.max(0, b.depositedToTreasury - b.treasuryCapitalWithdrawn);
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
  // Owed, not spent. Nobody's money has left for these yet, so they can't come
  // off partner capital — but the debt is real, which is why it's reported
  // rather than simply ignored.
  const supplierDue =
    purchases
      .filter((p) => p.onCredit)
      .reduce((s, p) => s + Number(p.unitCost) * p.quantity, 0) +
    internalPurchases
      .filter((ip) => ip.onCredit)
      .reduce((s, ip) => s + Number(ip.cost) * ip.quantity, 0);
  // Treasury spending is charged against the partner money in the pot first,
  // and only the excess is treated as the shop's own takings. Charging none of
  // it counted partner capital twice: still "unspent" here, and already stock
  // on the shelf over in inventoryValue.
  const salesFundedSpend = Math.max(0, treasuryFundedSpend - partnerCashInTreasury);
  const capitalSpend = totalExpenses - salesFundedSpend - supplierDue;
  const totalRemaining = netInvested - capitalSpend;

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
    partnerCashInTreasury: round2(partnerCashInTreasury),
    salesFundedSpend: round2(salesFundedSpend),
    supplierDue: round2(supplierDue),
    capitalSpend: round2(capitalSpend),
    totalRemaining: round2(totalRemaining),
    inventoryValue: stock.value,
    inventoryUnits: stock.units,
    inventoryFromCorrections: stock.fromCorrections,
    treasuryBalance: round2(treasury),
    // Cash and goods less the bills against them. Nothing from the capital
    // arithmetic above goes in: a partner deposit is already counted once as
    // treasury cash, and adding "unspent capital" on top would count it twice.
    businessHoldings: round2(treasury + stock.value - supplierDue),
  };
}

export type SupplierDue = {
  /** Null for rows bought on credit with no supplier recorded. */
  supplierId: string | null;
  supplierName: string;
  amount: number;
  /** How many unpaid rows make it up — stock and internal purchases together. */
  rows: number;
};

/**
 * Everything still owed for goods bought on credit, as one number.
 *
 * The cheap form of the question, for the paths that only need the total —
 * businessCapitalSummary reaches for every partner balance and values the whole
 * shelf on its way to the same figure. Only unpaid rows are read, and there are
 * never many of those.
 */
export async function supplierDueTotal(workspaceId: string): Promise<number> {
  const [purchases, internals] = await Promise.all([
    prisma.purchase.findMany({
      where: { workspaceId, onCredit: true },
      select: { unitCost: true, quantity: true },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId, onCredit: true },
      select: { cost: true, quantity: true },
    }),
  ]);
  return round2(
    purchases.reduce((s, p) => s + Number(p.unitCost) * p.quantity, 0) +
      internals.reduce((s, ip) => s + Number(ip.cost) * ip.quantity, 0),
  );
}

/**
 * What is owed to each supplier, biggest first.
 *
 * Everything still marked as bought on credit. Settling a bill is the existing
 * edit — switch the row's funding to Treasury or Partner — so a supplier drops
 * off this list exactly when the money is recorded as leaving.
 */
export async function supplierDues(workspaceId: string): Promise<SupplierDue[]> {
  const [purchases, internals] = await Promise.all([
    prisma.purchase.findMany({
      where: { workspaceId, onCredit: true },
      select: {
        unitCost: true,
        quantity: true,
        supplierId: true,
        supplier: { select: { name: true } },
      },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId, onCredit: true },
      select: {
        cost: true,
        quantity: true,
        supplierId: true,
        supplierName: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const map = new Map<string, SupplierDue>();
  const add = (supplierId: string | null, name: string | null, amount: number) => {
    const key = supplierId ?? "__none__";
    const row =
      map.get(key) ??
      map
        .set(key, {
          supplierId,
          // A bill nobody attributed is still a bill. Named rather than hidden,
          // so the total on the card and the rows under it always agree.
          supplierName: name ?? "No supplier recorded",
          amount: 0,
          rows: 0,
        })
        .get(key)!;
    row.amount += amount;
    row.rows += 1;
  };

  for (const p of purchases) {
    add(p.supplierId, p.supplier?.name ?? null, Number(p.unitCost) * p.quantity);
  }
  for (const ip of internals) {
    add(
      ip.supplierId,
      ip.supplier?.name ?? ip.supplierName,
      Number(ip.cost) * ip.quantity,
    );
  }

  return [...map.values()]
    .map((r) => ({ ...r, amount: round2(r.amount) }))
    .sort((a, b) => b.amount - a.amount);
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
  /** tradingProfit − operatingExpenses. Everything the business has earned. */
  netProfit: number;
  /** Profit already paid out to partners, across every distribution ever made. */
  distributed: number;
  /**
   * netProfit − distributed: what is left to hand out.
   *
   * The number every "your share" figure and every distribution check has to
   * use. netProfit on its own is a lifetime total and does not go down when
   * partners are paid, so asking it twice gives the same answer twice — which
   * is how the same profit gets distributed a second time with nothing
   * objecting. Can go negative, and says so: that means more has been taken
   * out than the business earned.
   */
  distributableProfit: number;
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
  const [orders, adSpendAgg, internalPurchases, miscAgg, writeOffs, distributedAgg] = await Promise.all([
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
    // What has already been handed out. Every share figure in the app is
    // "profit minus this" — without it the same profit is offered again every
    // time somebody looks.
    prisma.profitDistribution.aggregate({
      where: { workspaceId },
      _sum: { totalAmount: true },
    }),
  ]);

  const tradingProfit = orders.reduce((s, o) => s + orderNetProfit(o), 0);
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
  const netProfit = round2(tradingProfit - operatingExpenses);
  const distributed = round2(Number(distributedAgg._sum.totalAmount ?? 0));

  return {
    tradingProfit: round2(tradingProfit),
    adSpend: round2(adSpend),
    internalPurchaseSpend: round2(internalPurchaseSpend),
    miscExpense: round2(miscExpense),
    stockLoss: round2(stockLoss),
    prepaidExpenses: internal.prepaid,
    operatingExpenses: round2(operatingExpenses),
    netProfit,
    distributed,
    distributableProfit: round2(netProfit - distributed),
  };
}

export type OverdueOrder = DhakaStamp & {
  orderId: string;
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
  return (
    orders
      .map((o) => ({
        orderId: o.id,
        ...dhakaRecordStamp(o.date, o.createdAt, o.dateHasTime),
        daysOverdue: Math.floor((now - o.date.getTime()) / 86_400_000),
        // What is still owed, not what was invoiced. A 5,000 order with a
        // 3,000 advance was chased for the whole 5,000, and the customer who
        // had paid most of it looked like the one who had paid nothing.
        amount: amountOutstanding(o, computeOrderTotals(o)),
        customerName: o.customer?.name ?? "Walk-in",
        heldByName: o.heldBy ? (o.heldBy.user.name ?? o.heldBy.user.email) : null,
      }))
      // A PARTIAL order settled to the last taka owes nothing and doesn't
      // belong on an overdue list, whatever its status column still says.
      .filter((o) => o.amount > 0)
  );
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
    // Still to collect, so a part-paid order counts for the part outstanding.
    const amount = amountOutstanding(o, computeOrderTotals(o));
    if (amount <= 0) continue;
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

export type CustomerDue = {
  /** What customers have been billed and not paid. The figure to chase them for. */
  gross: number;
  /** The courier's cut of that, on the orders it will be collecting. */
  courierCut: number;
  /** gross − courierCut: what will actually reach the shop. */
  net: number;
};

/**
 * What customers still owe, across every non-cancelled UNPAID/PARTIAL order —
 * and what will be left of it once the courier has taken its charges.
 *
 * Both, because the two are used for different things and only one number was
 * ever given. What to chase a customer for is the invoice; what the shop will
 * receive is the invoice less the delivery charge and COD fee the courier keeps
 * on the way back. Sat next to "on the way", which has always been net, the
 * gross figure quietly promised money that was never coming — 667.15 of it on
 * nine orders, which is most of why the books wouldn't reconcile.
 */
export async function totalDue(workspaceId: string): Promise<CustomerDue> {
  const orders = await prisma.order.findMany({
    where: { workspaceId, status: { not: "CANCELLED" }, paymentStatus: { in: ["UNPAID", "PARTIAL"] } },
    include: { items: { include: { returns: true } } },
  });

  let gross = 0;
  let courierCut = 0;
  for (const o of orders) {
    const totals = computeOrderTotals(o);
    // Net of anything already paid towards each one — the whole point of a
    // PARTIAL status, and the one thing it never did.
    const outstanding = amountOutstanding(o, totals);
    if (outstanding <= 0) continue;
    gross += outstanding;
    // Same rule depositAmount uses: only a courier collection is netted, since
    // that is the only case where somebody else handles the money first. An
    // order whose cash is already banked has had its charges taken, and
    // charging them again would understate what is still coming.
    if (o.paymentMethod === "COURIER_COLLECTION" && !o.cashInTreasury) {
      courierCut += deliveryCostCharged(o, totals) + totals.codFeeCost;
    }
  }
  return {
    gross: round2(gross),
    courierCut: round2(courierCut),
    net: round2(gross - courierCut),
  };
}

export type PaidNotDeposited = DhakaStamp & {
  orderId: string;
  customerName: string;
  /** What will actually reach the treasury — a courier's cut already removed. */
  amount: number;
  /** What the customer paid. Equal to `amount` unless a courier collected it. */
  gross: number;
  /** Delivery cost + COD fee the courier keeps out of what it collected. */
  courierCharges: number;
  paymentMethod: string;
  heldByName: string | null;
  isCourierCollection: boolean;
  /** A refused parcel that collected the shipping anyway — not a sale. */
  cancelled: boolean;
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
      cashInTreasury: false,
      OR: [
        {
          status: { not: "CANCELLED" },
          // PARTIAL too: an advance is money the business is holding just as
          // much as a settled order's is. Restricting this to PAID left every
          // advance out of the "cash not yet in the treasury" list, which is
          // exactly the list somebody checks to find out where the money is.
          paymentStatus: { in: ["PAID", "PARTIAL"] },
        },
        // A refused parcel whose customer paid the shipping anyway. The courier
        // is holding that money exactly as it holds a delivered order's, so
        // leaving cancellations out made this card disagree with the courier
        // balance page — and with the courier's own app — by whatever a partial
        // delivery had collected. Its paymentStatus says nothing useful (the
        // sale never settled), so the test is what was collected.
        { status: "CANCELLED", cancelledCollected: { gt: 0 } },
      ],
    },
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
      heldBy: { include: { user: { select: { name: true, email: true } } } },
    },
    orderBy: { date: "asc" },
  });
  return orders
    .map((o) => {
      // What the courier will hand over, not what it collected — otherwise this
      // card promises the treasury money the courier is keeping.
      const deposit = depositAmount(o, computeOrderTotals(o));
      return {
        orderId: o.id,
        ...dhakaRecordStamp(o.date, o.createdAt, o.dateHasTime),
        customerName: o.customer?.name ?? "Walk-in",
        amount: deposit.net,
        gross: deposit.gross,
        courierCharges: deposit.courierCharges,
        paymentMethod: o.paymentMethod,
        heldByName: o.heldBy ? (o.heldBy.user.name ?? o.heldBy.user.email) : null,
        isCourierCollection: o.paymentMethod === "COURIER_COLLECTION",
        cancelled: o.status === "CANCELLED",
      };
    })
    // A PARTIAL order nobody has typed an amount onto has collected nothing
    // yet, so there is no cash of its to be waiting for.
    .filter((o) => o.amount > 0);
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
