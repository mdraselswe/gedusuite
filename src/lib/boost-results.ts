/**
 * What a boosting campaign actually produced.
 *
 * Facebook can say how many people clicked; it cannot say which of those
 * became an order in this shop. So results are worked out from two sources,
 * in this order of trust:
 *
 *   TAGGED     someone picked the campaign on the order itself. Exact.
 *   ESTIMATED  nobody tagged it, so orders are matched by the campaign's
 *              window (its ad sets' earliest start → latest end, or now while
 *              one is still running) and, when the campaign names a channel,
 *              by Order.source. A guess — an honest one, but a guess.
 *
 * Tagged wins whenever a single order carries the tag: mixing an exact set
 * with a guessed one produces a number nobody can defend. The untagged
 * in-window count is still reported alongside so the gap is visible.
 *
 * Two campaigns running on the same channel at the same time will both
 * estimate the same orders — `overlappingCampaigns` finds those so the page
 * can say so instead of quietly double-counting.
 */

import { computeOrderTotals, orderNetProfit, type OrderWithTotals } from "@/lib/orders";

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** An order reduced to what attribution needs. Money is already netted. */
export type AttributableOrder = {
  date: Date;
  source: string | null;
  boostCampaignId: string | null;
  netRevenue: number;
  netProfit: number;
  /**
   * A cancelled order: it sold nothing, but the ad that produced it was paid
   * for and its packaging and courier return charge were too. `netRevenue` is
   * 0 and `netProfit` is the negative cost, so the arithmetic below needs no
   * special case — only the order COUNT does, since counting a cancellation
   * as an order would flatter cost-per-order.
   */
  cancelled: boolean;
};

export type CampaignWindow = {
  from: Date;
  /** null while an ad set is still running — the window ends "now". */
  to: Date | null;
};

/** Enough of a campaign to attribute orders to it. */
export type AttributableCampaign = {
  id: string;
  name: string;
  channel: string | null;
  window: CampaignWindow | null; // null when the campaign has no ad sets yet
};

export type ChannelSplit = {
  source: string | null;
  orders: number;
  revenue: number;
  profit: number;
};

export type CampaignResult = {
  /** Which set the headline numbers came from. NONE = nothing to show. */
  basis: "TAGGED" | "ESTIMATED" | "NONE";
  spend: number;
  orders: number;
  revenue: number;
  profit: number;
  /** Revenue per taka of ad spend. Null when nothing was spent. */
  roas: number | null;
  /** Profit ÷ revenue on these orders, 0–1. Null when there's no revenue. */
  margin: number | null;
  /**
   * The ROAS at which the campaign's profit exactly covers its ad spend.
   *
   * 1 ÷ margin: at 27% margin every taka of revenue leaves 0.27 to pay for
   * ads, so it takes 3.7 taka of revenue per taka spent to break even. Null
   * when the orders make no profit at all — no amount of revenue fixes that,
   * so there is no ROAS to aim for.
   */
  breakEvenRoas: number | null;
  /** Ad cost per order. Null when there are no orders. */
  cpa: number | null;
  /** Profit the campaign is left with once its own spend is paid for. */
  profitAfterAds: number;
  /** Attributed orders that were cancelled, and what they still cost. */
  cancelledOrders: number;
  cancelledCost: number;
  /** Cancelled ÷ (sold + cancelled). Null when nothing was attributed. */
  cancelRate: number | null;
  /** How many orders carry the tag, whatever the basis ended up being. */
  taggedOrders: number;
  /** Untagged orders inside the window (and channel), whatever the basis. */
  estimatedOrders: number;
  /** Composition of the headline set, biggest revenue first. */
  byChannel: ChannelSplit[];
};

/**
 * Reduce a fetched order to what attribution needs.
 *
 * A cancelled order is kept rather than filtered out: the ad that produced it
 * was paid for either way, and dropping it would let a campaign whose orders
 * mostly come back look identical to one whose orders stick.
 */
export function toAttributable(
  order: OrderWithTotals & {
    date: Date;
    status: string;
    source: string | null;
    boostCampaignId: string | null;
  },
): AttributableOrder {
  const common = {
    date: order.date,
    source: order.source,
    boostCampaignId: order.boostCampaignId,
  };
  if (order.status === "CANCELLED") {
    return {
      ...common,
      netRevenue: 0,
      netProfit: orderNetProfit(order),
      cancelled: true,
    };
  }
  const t = computeOrderTotals(order);
  return { ...common, netRevenue: t.netRevenue, netProfit: t.netProfit, cancelled: false };
}

type AdSetDates = { startDate: Date; endDate: Date | null };

/**
 * The stretch of time a campaign was live: earliest ad set start to latest
 * end, with `to: null` while any ad set is still open-ended.
 */
export function campaignWindow(adSets: AdSetDates[]): CampaignWindow | null {
  if (adSets.length === 0) return null;
  const from = adSets.reduce(
    (min, a) => (a.startDate < min ? a.startDate : min),
    adSets[0].startDate,
  );
  if (adSets.some((a) => a.endDate === null)) return { from, to: null };
  const to = adSets.reduce<Date | null>(
    (max, a) => (max === null || (a.endDate && a.endDate > max) ? a.endDate : max),
    null,
  );
  return { from, to };
}

/**
 * Whether an order's date falls inside the window. Ad set dates are date-only
 * (midnight UTC), so the end day is included in full rather than cut off at
 * its first second.
 */
function inWindow(date: Date, window: CampaignWindow, now: Date): boolean {
  if (date < window.from) return false;
  if (window.to === null) return date <= now;
  const endOfDay = new Date(window.to);
  endOfDay.setUTCHours(23, 59, 59, 999);
  return date <= endOfDay;
}

function summarise(orders: AttributableOrder[]) {
  let revenue = 0;
  let profit = 0;
  let cancelledOrders = 0;
  let cancelledCost = 0;
  for (const o of orders) {
    revenue += o.netRevenue;
    profit += o.netProfit;
    if (o.cancelled) {
      cancelledOrders += 1;
      cancelledCost += -o.netProfit;
    }
  }
  return {
    orders: orders.filter((o) => !o.cancelled).length,
    revenue: round2(revenue),
    profit: round2(profit),
    cancelledOrders,
    cancelledCost: round2(cancelledCost),
  };
}

function splitByChannel(orders: AttributableOrder[]): ChannelSplit[] {
  const map = new Map<string, { orders: number; revenue: number; profit: number }>();
  for (const o of orders) {
    const key = o.source ?? "";
    const acc = map.get(key) ?? { orders: 0, revenue: 0, profit: 0 };
    acc.orders += 1;
    acc.revenue += o.netRevenue;
    acc.profit += o.netProfit;
    map.set(key, acc);
  }
  return [...map.entries()]
    .map(([source, v]) => ({
      source: source || null,
      orders: v.orders,
      revenue: round2(v.revenue),
      profit: round2(v.profit),
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * @param orders  every non-cancelled order that could belong to this campaign
 *                (the caller decides how far back to look)
 * @param now     "today" for a campaign still running; injected so a result is
 *                reproducible in a test
 */
export function buildCampaignResult(
  campaign: AttributableCampaign,
  orders: AttributableOrder[],
  spend: number,
  now: Date = new Date(),
): CampaignResult {
  const tagged = orders.filter((o) => o.boostCampaignId === campaign.id);
  const estimated = campaign.window
    ? orders.filter(
        (o) =>
          o.boostCampaignId === null &&
          inWindow(o.date, campaign.window!, now) &&
          (campaign.channel === null || o.source === campaign.channel),
      )
    : [];

  const basis = tagged.length > 0 ? "TAGGED" : estimated.length > 0 ? "ESTIMATED" : "NONE";
  const headline = basis === "TAGGED" ? tagged : estimated;
  const totals = summarise(headline);

  const margin = totals.revenue > 0 ? totals.profit / totals.revenue : null;

  return {
    basis,
    spend: round2(spend),
    ...totals,
    // Guarded rather than Infinity: a campaign with revenue and no recorded
    // spend has no ROAS to show, and "∞" in a money report reads as a bug.
    roas: spend > 0 ? round2(totals.revenue / spend) : null,
    margin: margin === null ? null : Math.round(margin * 1000) / 1000,
    breakEvenRoas: margin !== null && margin > 0 ? round2(1 / margin) : null,
    cpa: totals.orders > 0 ? round2(spend / totals.orders) : null,
    profitAfterAds: round2(totals.profit - spend),
    cancelRate:
      totals.orders + totals.cancelledOrders > 0
        ? totals.cancelledOrders / (totals.orders + totals.cancelledOrders)
        : null,
    taggedOrders: tagged.length,
    estimatedOrders: estimated.length,
    byChannel: splitByChannel(headline.filter((o) => !o.cancelled)),
  };
}

/**
 * Whether a ROAS is actually paying for itself.
 *
 * Measured against the campaign's own break-even, never against 1.0×: at a
 * 27% margin a 2.45× ROAS is a loss, and colouring it green because it
 * cleared 1.0 tells the reader the opposite of what happened. Orders that
 * make no profit at all are "bad" whatever the ROAS — there is nothing for
 * the ad spend to come out of.
 */
export function roasVerdict(result: CampaignResult): "good" | "bad" | null {
  if (result.roas === null) return null;
  if (result.breakEvenRoas === null) return "bad";
  return result.roas >= result.breakEvenRoas ? "good" : "bad";
}

/**
 * Other campaigns whose window and channel overlap this one's — every order
 * the estimate claims, theirs claims too. Only matters while a campaign is
 * being estimated; tagged results are unambiguous by construction.
 */
export function overlappingCampaigns(
  campaign: AttributableCampaign,
  others: AttributableCampaign[],
  now: Date = new Date(),
): string[] {
  if (!campaign.window) return [];
  const end = (w: CampaignWindow) => w.to ?? now;
  return others
    .filter((other) => {
      if (other.id === campaign.id || !other.window) return false;
      // A null channel matches everything, so it collides with any campaign.
      const sameChannel =
        campaign.channel === null ||
        other.channel === null ||
        other.channel === campaign.channel;
      if (!sameChannel) return false;
      return other.window.from <= end(campaign.window!) && campaign.window!.from <= end(other.window);
    })
    .map((other) => other.name);
}
