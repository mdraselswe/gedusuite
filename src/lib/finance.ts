import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals, orderNetProfit } from "@/lib/orders";
import {
  amountOutstanding,
  bankedSoFar,
  collectionRecorded,
  depositAmount,
  deliveryCostCharged,
  stillToBank,
} from "@/lib/order-cash";
import { inventoryValue, variantCost } from "@/lib/inventory";
import { amortizeAll } from "@/lib/amortize";
import { splitByShare } from "@/lib/profit-share";
import { sharePotSpending, type PotEvent } from "@/lib/treasury-pot";
import { dhakaRecordStamp, type DhakaStamp } from "@/lib/dhaka-time";
import { round2 } from "@/lib/money";

export const OVERDUE_DAYS = 7;


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
  // The three "their own money" figures. A row the treasury reimbursed them
  // for is excluded from all three — it names them, but the treasury is what
  // paid (see lib/funding.ts).
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
   * by what each partner had in the pot at the moment of each spend rather than
   * by profit share.
   *
   * Pooled cash carries no name, but a capital account isn't about which note
   * left — it's about whose claim shrinks. Sharing it by profit percent would
   * charge a partner who deposited nothing, and would make the same purchase
   * cost different amounts depending on whether the money went via the treasury
   * or straight to the supplier. By deposit, the two routes agree.
   *
   * Worked out by walking the pot in date order (see lib/treasury-pot), so a
   * deposit can only be spent by purchases made after it arrived.
   */
  treasuryCapitalSpend: number;
  /**
   * What of their deposit is still sitting unspent in the pot — deposited, less
   * what they have taken back out, less what the treasury has since spent of
   * it. The honest answer to "how much of the treasury is still my money".
   */
  treasuryCapitalRemaining: number;
  netCapital: number; // invested + depositedToTreasury − capitalWithdrawn
  /** netCapital − expenses − treasuryCapitalSpend: what's left of their capital to spend. */
  remaining: number;
};

/** What a partner spent out of their own pocket, and on what. */
export type PartnerSpendKind = "PRODUCT" | "INTERNAL" | "BOOST";

/** The partner ledger, as the arithmetic below needs it. */
export type PartnerLedgerInput = {
  txns: {
    partnerId: string;
    type: string;
    amount: number;
    date: Date;
    /** Part of a profit distribution — that hands out earnings, not capital. */
    fromDistribution: boolean;
    /** Whether the treasury pot itself moved. */
    movedTreasury: boolean;
  }[];
  /**
   * Spending a partner paid for themselves. A row the treasury reimbursed them
   * for does not belong here — the money that finally left was the treasury's
   * (see lib/funding.ts).
   */
  partnerSpend: { partnerId: string; amount: number; kind: PartnerSpendKind }[];
  /** What the treasury paid for, with the dates it paid on. */
  treasurySpend: { at: Date; amount: number }[];
};

/**
 * The partner-balance arithmetic, with the database left outside.
 *
 * Split out from `partnerBalances` so the tests can reach it. They used to run
 * against a copy of these rules declared at the top of finance.test.ts, which
 * meant the shipped function had no coverage at all and the two were free to
 * drift — and they did: after the pot walk replaced the old lifetime
 * min(spend, deposits) rule, the copy went on charging by the old one and all
 * thirty tests still passed. On this shop's live data the two disagreed by
 * 888.67 of capital spend, with nothing to say so.
 */
export function rollUpBalances(input: PartnerLedgerInput): Map<string, PartnerBalance> {
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
        treasuryCapitalRemaining: 0,
        netCapital: 0,
        remaining: 0,
      })
      .get(id)!;

  // Every movement of the pot, in the order it happened — the ledger
  // sharePotSpending walks below.
  const potEvents: PotEvent[] = [];

  for (const r of input.txns) {
    const b = ensure(r.partnerId);
    if (r.type === "INVESTMENT") b.invested += r.amount;
    else if (r.type === "EXPENSE") b.miscExpense += r.amount;
    else if (r.type === "DEPOSIT_TO_TREASURY") {
      b.depositedToTreasury += r.amount;
      potEvents.push({ at: r.date, kind: "DEPOSIT", partnerId: r.partnerId, amount: r.amount });
    } else if (r.type === "WITHDRAWAL") {
      b.withdrawn += r.amount;
      // A distribution hands out earnings, not capital, so it leaves what a
      // partner has invested exactly where it was.
      if (r.fromDistribution) continue;
      b.capitalWithdrawn += r.amount;
      if (r.movedTreasury) {
        b.treasuryCapitalWithdrawn += r.amount;
        potEvents.push({ at: r.date, kind: "WITHDRAWAL", partnerId: r.partnerId, amount: r.amount });
      }
    }
  }
  for (const s of input.partnerSpend) {
    const b = ensure(s.partnerId);
    if (s.kind === "PRODUCT") b.customerProductSpend += s.amount;
    else if (s.kind === "INTERNAL") b.internalPurchaseSpend += s.amount;
    else b.boostSpend += s.amount;
  }
  for (const s of input.treasurySpend) {
    potEvents.push({ at: s.at, kind: "SPEND", amount: s.amount });
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
  // partner's stake in the pot as it stood at each moment it was spent from.
  //
  // This used to compare two lifetime sums — all treasury spending ever against
  // all partner deposits ever, charged as min(spend, pool). Once lifetime
  // spending passed lifetime deposits, which it does in any shop that has been
  // trading a while, every partner's whole deposit read as spent the instant it
  // landed: hand over 5,000 on a Tuesday and "remaining" would not move,
  // because last week's purchases had already been charged against money that
  // did not exist when they were made.
  const share = sharePotSpending(potEvents);
  for (const b of map.values()) {
    b.treasuryCapitalSpend = share.capitalSpent.get(b.partnerId) ?? 0;
    b.treasuryCapitalRemaining = share.stillInPot.get(b.partnerId) ?? 0;
    b.remaining = round2(b.netCapital - b.expenses - b.treasuryCapitalSpend);
  }
  return map;
}

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
    txns,
    purchaseRows,
    internalRows,
    boostRows,
    treasuryPurchases,
    treasuryInternals,
    treasuryBoost,
  ] = await Promise.all([
    // Row by row rather than three groupBys, because the pot is now walked in
    // date order and a grouped sum has no date on it. The table is small — a
    // few hundred rows in a shop's whole life — and this is one round trip
    // where there were three.
    prisma.partnerTxn.findMany({
      where: { workspaceId },
      select: {
        partnerId: true,
        type: true,
        amount: true,
        date: true,
        distributionId: true,
        // Whether the pot actually moved. A withdrawal of cash a partner was
        // holding elsewhere leaves the treasury alone, and so leaves
        // everyone's share of it alone.
        treasuryEntry: { select: { id: true } },
      },
    }),
    // `paidFromTreasury: false` is what keeps a reimbursed row out of the
    // partner's expenses. A row carrying both columns means they fronted the
    // cash and the treasury paid them back (see lib/funding.ts): the money that
    // finally left was the treasury's, so it belongs to treasuryFundedSpend
    // below and not here. Their name stays on the row as a record of who
    // handed it over, and counting that as their spending is exactly what used
    // to drive a reimbursing partner's "remaining" negative.
    prisma.purchase.findMany({
      where: { workspaceId, paidByPartnerId: { not: null }, paidFromTreasury: false },
      select: { paidByPartnerId: true, unitCost: true, quantity: true },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId, paidByPartnerId: { not: null }, paidFromTreasury: false },
      select: { paidByPartnerId: true, cost: true, quantity: true },
    }),
    prisma.boostDailySpend.groupBy({
      by: ["paidByPartnerId"],
      where: { workspaceId, paidByPartnerId: { not: null }, paidFromTreasury: false },
      _sum: { amount: true },
    }),
    // Everything the treasury paid for, with the dates it paid on. Read again
    // here rather than handed down from businessCapitalSummary: the partner
    // pages call this function on its own, and a balance that only came out
    // right when the rollup happened to be running alongside it would be worse
    // than the extra three queries.
    prisma.purchase.findMany({
      where: { workspaceId, paidFromTreasury: true },
      select: { unitCost: true, quantity: true, date: true },
    }),
    prisma.internalPurchase.findMany({
      where: { workspaceId, paidFromTreasury: true },
      select: { cost: true, quantity: true, date: true },
    }),
    prisma.boostDailySpend.findMany({
      where: { workspaceId, paidFromTreasury: true },
      select: { amount: true, date: true },
    }),
  ]);

  // Nothing but shape-shifting from here: the arithmetic is rollUpBalances,
  // which the tests can call without a database in front of it.
  return rollUpBalances({
    txns: txns.map((r) => ({
      partnerId: r.partnerId,
      type: r.type,
      amount: Number(r.amount),
      date: r.date,
      fromDistribution: r.distributionId != null,
      movedTreasury: r.treasuryEntry != null,
    })),
    partnerSpend: [
      ...purchaseRows.map((p) => ({
        partnerId: p.paidByPartnerId!,
        amount: Number(p.unitCost) * p.quantity,
        kind: "PRODUCT" as const,
      })),
      ...internalRows.map((ip) => ({
        partnerId: ip.paidByPartnerId!,
        amount: Number(ip.cost) * ip.quantity,
        kind: "INTERNAL" as const,
      })),
      ...boostRows.map((bs) => ({
        partnerId: bs.paidByPartnerId!,
        amount: Number(bs._sum.amount ?? 0),
        kind: "BOOST" as const,
      })),
    ],
    treasurySpend: [
      ...treasuryPurchases.map((p) => ({ at: p.date, amount: Number(p.unitCost) * p.quantity })),
      ...treasuryInternals.map((ip) => ({ at: ip.date, amount: Number(ip.cost) * ip.quantity })),
      ...treasuryBoost.map((bs) => ({ at: bs.date, amount: Number(bs.amount) })),
    ],
  });
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
   * deposited, less any capital they've taken back out of it, less what the
   * treasury has since spent of it. Profit distributions aren't in here —
   * those hand out earnings, not capital.
   *
   * The last of those three used to be missing, so a deposit the treasury had
   * already turned into stock went on being reported as partner money in the
   * pot — and the card promised the partners a share of a balance that was by
   * then entirely sales takings.
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
   * The other side of that: treasury spending that came out of partner
   * deposits, and so did cost somebody capital. salesFundedSpend +
   * treasuryCapitalSpend = treasuryFundedSpend, by construction — the pot walk
   * splits every spend between the two.
   */
  treasuryCapitalSpend: number;
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

/** What the whole-business rollup needs, with the database left outside. */
export type CapitalInput = {
  /** Every partner's balances — the output of rollUpBalances. */
  balances: Iterable<PartnerBalance>;
  /**
   * Every bit of spending in the workspace, tagged or not. `MISC` is a manual
   * partner expense, which is their own money by definition and so is never
   * treasury-funded and never on credit.
   */
  spend: {
    amount: number;
    kind: PartnerSpendKind | "MISC";
    paidFromTreasury: boolean;
    onCredit: boolean;
  }[];
  inventory: { value: number; units: number; fromCorrections: number };
  treasuryBalance: number;
};

/**
 * The whole-business capital arithmetic, with the database left outside.
 *
 * Split out for the same reason as rollUpBalances: this is the sum that decides
 * what each partner is told they still own, and the only thing testing it was a
 * paraphrase of it living in the test file.
 */
export function summariseCapital(input: CapitalInput): BusinessCapitalSummary {
  let totalInvested = 0;
  let totalCapitalWithdrawn = 0;
  // The pot's partner-funded part, stake by stake — the same walk
  // rollUpBalances runs, so the table and this card can't disagree about how
  // much of the treasury is still capital.
  //
  // Net of what the treasury has since spent of it, which it did not used to
  // be: a deposit fully consumed by a purchase went on being reported as
  // partner money sitting in the pot, and the note under the card promised the
  // partners a share of a balance that was by then entirely sales cash.
  let partnerCashInTreasury = 0;
  // Their side of the same sum: treasury spending that came out of partner
  // deposits rather than takings.
  let treasuryCapitalSpend = 0;
  for (const b of input.balances) {
    // Both routes into the business, added together: money a partner spent
    // straight from their pocket, and money they handed to the treasury.
    totalInvested += b.invested + b.depositedToTreasury;
    totalCapitalWithdrawn += b.capitalWithdrawn;
    partnerCashInTreasury += b.treasuryCapitalRemaining;
    treasuryCapitalSpend += b.treasuryCapitalSpend;
  }
  // What's still in. Summing `invested` alone would go on reporting money a
  // partner has already taken back as though it were still funding the shop.
  const netInvested = totalInvested - totalCapitalWithdrawn;

  const sumWhere = (pick: (r: CapitalInput["spend"][number]) => boolean) =>
    input.spend.filter(pick).reduce((s, r) => s + r.amount, 0);
  const customerProductSpend = sumWhere((r) => r.kind === "PRODUCT");
  const internalPurchaseSpend = sumWhere((r) => r.kind === "INTERNAL");
  const boostSpend = sumWhere((r) => r.kind === "BOOST");
  const miscExpense = sumWhere((r) => r.kind === "MISC");
  const totalExpenses = customerProductSpend + internalPurchaseSpend + boostSpend + miscExpense;

  // Paid for out of the shared pot. A manual PartnerTxn EXPENSE is a partner's
  // own money by definition, so it never appears here.
  const treasuryFundedSpend = sumWhere((r) => r.paidFromTreasury);
  // Owed, not spent. Nobody's money has left for these yet, so they can't come
  // off partner capital — but the debt is real, which is why it's reported
  // rather than simply ignored.
  const supplierDue = sumWhere((r) => r.onCredit);
  // Treasury spending is charged against the partner money in the pot first,
  // and only the excess is treated as the shop's own takings. Charging none of
  // it counted partner capital twice: still "unspent" here, and already stock
  // on the shelf over in inventoryValue.
  //
  // Taken from what the pot walk actually charged the partners rather than
  // recomputed from lifetime totals — every spend it saw was split between the
  // two, so the remainder is this by construction, and the per-partner table
  // and this card cannot land on different answers.
  const salesFundedSpend = Math.max(0, round2(treasuryFundedSpend - treasuryCapitalSpend));
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
    treasuryCapitalSpend: round2(treasuryCapitalSpend),
    supplierDue: round2(supplierDue),
    capitalSpend: round2(capitalSpend),
    totalRemaining: round2(totalRemaining),
    inventoryValue: input.inventory.value,
    inventoryUnits: input.inventory.units,
    inventoryFromCorrections: input.inventory.fromCorrections,
    treasuryBalance: round2(input.treasuryBalance),
    // Cash and goods less the bills against them. Nothing from the capital
    // arithmetic above goes in: a partner deposit is already counted once as
    // treasury cash, and adding "unspent capital" on top would count it twice.
    businessHoldings: round2(input.treasuryBalance + input.inventory.value - supplierDue),
  };
}

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
    // Grouped rather than two aggregates: the treasury-funded half and the
    // whole now come from one read and cannot disagree about the same rows.
    prisma.boostDailySpend.groupBy({
      by: ["paidFromTreasury"],
      where: { workspaceId },
      _sum: { amount: true },
    }),
    // The asset side of all that purchasing — see businessHoldings.
    inventoryValue(workspaceId),
    treasuryBalance(workspaceId),
  ]);

  // Nothing but shape-shifting from here: the arithmetic is summariseCapital,
  // which the tests can call without a database in front of it.
  return summariseCapital({
    balances: balances.values(),
    spend: [
      ...purchases.map((p) => ({
        amount: Number(p.unitCost) * p.quantity,
        kind: "PRODUCT" as const,
        paidFromTreasury: p.paidFromTreasury,
        onCredit: p.onCredit,
      })),
      ...internalPurchases.map((ip) => ({
        amount: Number(ip.cost) * ip.quantity,
        kind: "INTERNAL" as const,
        paidFromTreasury: ip.paidFromTreasury,
        onCredit: ip.onCredit,
      })),
      ...boostRows.map((b) => ({
        amount: Number(b._sum.amount ?? 0),
        kind: "BOOST" as const,
        paidFromTreasury: b.paidFromTreasury,
        // Ads are never bought on terms — there is no supplier to owe.
        onCredit: false,
      })),
      {
        amount: Number(miscRows._sum.amount ?? 0),
        kind: "MISC" as const,
        // A manual partner expense is their own money by definition.
        paidFromTreasury: false,
        onCredit: false,
      },
    ],
    inventory: stock,
    treasuryBalance: treasury,
  });
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

export type OperatingExpenses = {
  /** Advertising — every BoostDailySpend in the range, whoever funded it. */
  adSpend: number;
  /**
   * Internal purchases charged to the range. One with `spreadMonths` set
   * contributes only the part that has elapsed inside it; the rest is
   * `prepaidExpenses`.
   */
  internalPurchaseSpend: number;
  /** Manual partner EXPENSE entries — anything with no dedicated record. */
  miscExpense: number;
  /** Stock written off as damaged or lost, valued at what it cost to buy. */
  stockLoss: number;
  /**
   * Spread costs paid for but not yet charged to any period — a year of
   * hosting with eight months left to run. Beside the total, never inside it.
   */
  prepaidExpenses: number;
  /** adSpend + internalPurchaseSpend + miscExpense + stockLoss. */
  total: number;
};

/**
 * What it costs to run the shop over a range — one function, three callers.
 *
 * The reports page, the lifetime profit rollup and the dashboard tile all have
 * to subtract the same four things from trading profit, and each of them used
 * to do it with its own copy of the list. That is how the dashboard came to
 * show a month at ৳11,018 of profit while the same month, on the reports page,
 * had spent ৳8,165 on ads and ৳3,914 on internal purchases and was ৳1,061 down.
 * Both were adding up honestly; only one of them had the whole list.
 *
 * `range` null means the lifetime figure. Internal purchases are deliberately
 * not filtered in the query — a March purchase spread over a year still puts
 * part of itself into a May report — so the range is applied by the amortizer,
 * which knows how much of each cost belongs where.
 */
export async function operatingExpenses(
  workspaceId: string,
  range: { from: Date; to: Date } | null,
): Promise<OperatingExpenses> {
  const dateFilter = range ? { date: { gte: range.from, lte: range.to } } : {};
  const [adSpendAgg, internalPurchases, miscAgg, writeOffs] = await Promise.all([
    prisma.boostDailySpend.aggregate({ _sum: { amount: true }, where: { workspaceId, ...dateFilter } }),
    prisma.internalPurchase.findMany({
      where: { workspaceId },
      select: { cost: true, quantity: true, date: true, spreadMonths: true },
    }),
    prisma.partnerTxn.aggregate({
      _sum: { amount: true },
      where: { workspaceId, type: "EXPENSE", ...dateFilter },
    }),
    // Stock that left without being sold. It was bought with real money and it
    // is never coming back, but nothing recognised it as a loss: profit only
    // ever sees cost when something sells, so a broken box simply vanished
    // from the shelf and from the accounts at the same time.
    prisma.stockAdjustment.findMany({
      where: { workspaceId, type: { in: ["DAMAGED", "LOST"] }, ...dateFilter },
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

  const adSpend = round2(Number(adSpendAgg._sum.amount ?? 0));
  const internal = amortizeAll(
    internalPurchases.map((ip) => ({
      date: ip.date,
      amount: Number(ip.cost) * ip.quantity,
      spreadMonths: ip.spreadMonths,
    })),
    range,
  );
  const internalPurchaseSpend = internal.recognized;
  const miscExpense = round2(Number(miscAgg._sum.amount ?? 0));
  const stockLoss = round2(
    writeOffs.reduce((s, a) => s + Math.abs(Math.min(0, a.delta)) * variantCost(a.productVariant), 0),
  );
  return {
    adSpend,
    internalPurchaseSpend,
    miscExpense,
    stockLoss,
    prepaidExpenses: internal.prepaid,
    total: round2(adSpend + internalPurchaseSpend + miscExpense + stockLoss),
  };
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
  const [orders, expenses, distributedAgg] = await Promise.all([
    prisma.order.findMany({
      where: { workspaceId },
      include: { items: { include: { returns: true } } },
    }),
    // The same four costs the reports page and the dashboard subtract, from
    // the same function — lifetime here, a range there.
    operatingExpenses(workspaceId, null),
    // What has already been handed out. Every share figure in the app is
    // "profit minus this" — without it the same profit is offered again every
    // time somebody looks.
    prisma.profitDistribution.aggregate({
      where: { workspaceId },
      _sum: { totalAmount: true },
    }),
  ]);

  const tradingProfit = orders.reduce((s, o) => s + orderNetProfit(o), 0);
  const netProfit = round2(tradingProfit - expenses.total);
  const distributed = round2(Number(distributedAgg._sum.totalAmount ?? 0));

  return {
    tradingProfit: round2(tradingProfit),
    adSpend: expenses.adSpend,
    internalPurchaseSpend: expenses.internalPurchaseSpend,
    miscExpense: expenses.miscExpense,
    stockLoss: expenses.stockLoss,
    prepaidExpenses: expenses.prepaidExpenses,
    operatingExpenses: expenses.total,
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
  /**
   * What is still to reach the treasury — a courier's cut already removed, and
   * anything already banked against this order taken off. Negative when the
   * courier's charges outran what it collected: that is money leaving, not
   * arriving.
   */
  amount: number;
  /**
   * How much of this order's cash the treasury already holds.
   *
   * Non-zero on a part-paid order that was banked and has since taken another
   * instalment: the first payment is in, the second is still in somebody's
   * pocket, and only the second is waiting to be confirmed.
   */
  alreadyBanked: number;
  /** What the customer paid. Equal to `amount` unless a courier collected it. */
  gross: number;
  courierName: string | null;
  /**
   * Whether this charge is going to take itself out of the next payout.
   *
   * A courier that nets its charges inside the balance it is holding — which
   * is every courier this app can read a balance and a payout from — settles
   * a returned parcel's bill by paying that much less next time. Recording it
   * as an outflow as well takes it out twice: once by hand, and again when the
   * payout arrives already short of it.
   */
  settlesAtPayout: boolean;
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
      // Deliberately not filtered to `cashInTreasury: false`. An order banked
      // while it was part-paid can take another instalment afterwards, and that
      // instalment is in somebody's pocket exactly as the first one was. Filtered
      // out, it appeared nowhere — while the treasury quietly claimed it, because
      // the entry used to grow itself. What is waiting is now worked out per
      // order below, as collected less already banked, so an order drops off this
      // list when the two agree rather than when a flag is set.
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
        // sale never settled), so the test is what was collected — or, for a
        // parcel that collected nothing, what the courier charged to bring it
        // back, which is just as real and moves the balance the other way.
        { status: "CANCELLED", cancelledCollected: { gt: 0 } },
        { status: "CANCELLED", deliveryCost: { gt: 0 } },
      ],
    },
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
      heldBy: { include: { user: { select: { name: true, email: true } } } },
      // Only to answer "can this courier be asked what it paid" — the key
      // itself is read here and turned into a yes or no on the next line, and
      // never leaves the server.
      courier: { select: { name: true, apiKeyEnc: true } },
      // What the treasury already holds against this order, if anything.
      treasuryEntry: { select: { type: true, amount: true } },
    },
    orderBy: { date: "asc" },
  });
  return orders.flatMap((o) => {
    // What the courier will hand over, not what it collected — otherwise this
    // card promises the treasury money the courier is keeping.
    const deposit = depositAmount(o, computeOrderTotals(o));
    // Signed, because an order's entry can be a courier's charge going the
    // other way.
    const alreadyBanked = bankedSoFar(o.treasuryEntry);
    const outstanding = stillToBank(deposit.net, alreadyBanked);
    // Rows with nothing to settle drop out. A PARTIAL order nobody has typed
    // an amount onto has collected nothing yet, so there is no cash of its to
    // be waiting for — and a courier charge may not be booked as an outflow
    // against a blank figure either.
    if (deposit.net === 0 || outstanding === 0) return [];
    if (deposit.net < 0 && !collectionRecorded(o)) return [];
    // A courier bills for the trip when it ends — on delivery, or on the way
    // back. A parcel still in transit has been charged nothing yet, so booking
    // its charge as money already gone puts the treasury out by it for as long
    // as the parcel is moving. A giveaway is where this bites: it collects
    // nothing, so it reads as a pure outflow from the moment it is handed over.
    // The courier balance page has always kept in-transit parcels out for the
    // same reason; this is that test, applied to the money side.
    if (deposit.net < 0 && o.status !== "DELIVERED" && o.status !== "CANCELLED") return [];
    return [
      {
        orderId: o.id,
        ...dhakaRecordStamp(o.date, o.createdAt, o.dateHasTime),
        customerName: o.customer?.name ?? "Walk-in",
        amount: outstanding,
        alreadyBanked,
        gross: deposit.gross,
        courierCharges: deposit.courierCharges,
        paymentMethod: o.paymentMethod,
        heldByName: o.heldBy ? (o.heldBy.user.name ?? o.heldBy.user.email) : null,
        isCourierCollection: o.paymentMethod === "COURIER_COLLECTION",
        courierName: o.courier?.name ?? null,
        settlesAtPayout: !!o.courier?.apiKeyEnc,
        cancelled: o.status === "CANCELLED",
      },
    ];
  });
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
