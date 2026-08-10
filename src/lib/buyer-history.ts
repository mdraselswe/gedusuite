import { normalizePhone } from "@/lib/phone";

/**
 * What a phone number has already done with this shop.
 *
 * The call list used to say nothing about it, so whoever picked up the phone
 * could not tell a first-time buyer from someone on their fifth order — or,
 * more expensively, from a number that has refused three COD parcels. The
 * order history was always there; nothing joined it to the lead.
 *
 * Keyed on the phone number rather than the customer record on purpose. A lead
 * only gains a customer record when somebody presses "Create customer", and
 * the moment worth knowing this is BEFORE that, while the call is being made.
 */
export type BuyerHistory = {
  /** Other orders this number has, not counting the one this lead became. */
  previous: number;
  delivered: number;
  cancelled: number;
};

/** Just enough of an order to summarise a number's track record. */
export type HistoryOrder = {
  id: string;
  customerId: string | null;
  status: string;
};

/**
 * Build a phone → history lookup for a page of leads.
 *
 * `customers` and `orders` are the rows already fetched for those phone
 * numbers; this does the joining and counting so it can be tested without a
 * database. Phones are normalised on both sides — "+8801712345678" and
 * "01712 345678" are the same buyer, and the whole point is not to miss that.
 */
export function buildBuyerHistory(
  customers: { id: string; phone: string | null; altPhone: string | null }[],
  orders: HistoryOrder[],
): Map<string, BuyerHistory> {
  const customerToPhones = new Map<string, string[]>();
  for (const c of customers) {
    const phones = [normalizePhone(c.phone), normalizePhone(c.altPhone)].filter(
      (p): p is string => !!p,
    );
    if (phones.length) customerToPhones.set(c.id, [...new Set(phones)]);
  }

  const byPhone = new Map<string, HistoryOrder[]>();
  for (const order of orders) {
    if (!order.customerId) continue;
    for (const phone of customerToPhones.get(order.customerId) ?? []) {
      const list = byPhone.get(phone);
      if (list) list.push(order);
      else byPhone.set(phone, [order]);
    }
  }

  const out = new Map<string, BuyerHistory>();
  for (const [phone, list] of byPhone) {
    out.set(phone, {
      previous: list.length,
      delivered: list.filter((o) => o.status === "DELIVERED").length,
      cancelled: list.filter((o) => o.status === "CANCELLED").length,
    });
  }
  return out;
}

/**
 * This lead's own view of that history.
 *
 * The order the lead itself became is subtracted, so a brand-new customer
 * whose order has already been entered reads as no history rather than as a
 * returning buyer. `null` when there's nothing to show — the common case, and
 * the row stays clean.
 */
export function historyForLead(
  histories: Map<string, BuyerHistory>,
  phone: string,
  ownOrderId: string | null,
  ownOrderStatus: string | null,
): BuyerHistory | null {
  const key = normalizePhone(phone);
  if (!key) return null;
  const h = histories.get(key);
  if (!h) return null;

  const own = ownOrderId ? 1 : 0;
  const previous = h.previous - own;
  if (previous <= 0) return null;

  return {
    previous,
    delivered: h.delivered - (ownOrderStatus === "DELIVERED" ? 1 : 0),
    cancelled: h.cancelled - (ownOrderStatus === "CANCELLED" ? 1 : 0),
  };
}
