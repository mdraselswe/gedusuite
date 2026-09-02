/**
 * Carts that were filled in on the website and never ordered.
 *
 * WooCommerce cannot tell us about these. Its cart is an anonymous session
 * keyed by a Cart-Token, there is no REST endpoint that lists live carts, and
 * no name or phone exists anywhere until the customer types one. WooCommerce
 * only writes a row — a `checkout-draft` order — once somebody has pressed
 * Place order and it failed, which is a small fraction of the people who walk
 * away: nine of them in a month against roughly a hundred and eighty that the
 * pixel counted reaching checkout.
 *
 * So the storefront sends what the customer has typed as they type it. This
 * file is the vocabulary both sides agree on; the writing happens in
 * abandoned-cart-store, which is kept separate because the call list is a
 * client component and cannot pull Prisma into its bundle.
 *
 * What arrives becomes an ordinary OrderLead, which is the whole point: it
 * goes straight into the same call list, with the same call status, attempts,
 * "create customer" and linked-order machinery a real order's lead has.
 * Nothing here needs a new table or a new page.
 */

import { normalizePhone } from "@/lib/phone";

/** Keeps these rows apart from WooCommerce's in OrderLead's unique key. */
export const CART_SOURCE = "ABANDONED_CART";

/**
 * Sits in `wooStatus` beside WooCommerce's own values, so the call list can
 * badge and filter it exactly the way it already does "checkout-draft".
 */
export const CART_STATUS = "abandoned-cart";

/**
 * How long after the last keystroke a cart counts as walked away from.
 *
 * The snapshot arrives while the customer is still on the page — calling then
 * would mean phoning somebody who is mid-purchase. Rows younger than this are
 * stored but hidden from the call list.
 */
export const ABANDON_AFTER_MS = 30 * 60 * 1000;

export type CartSnapshotItem = {
  productId?: number;
  name?: string;
  quantity?: number;
  /** Line total in taka, already converted out of Woo's minor units. */
  lineTotal?: number;
};

export type CartSnapshot = {
  phone?: string;
  name?: string;
  address?: string;
  area?: string;
  district?: string;
  items?: CartSnapshotItem[];
  total?: number;
};

/**
 * One row per person, keyed by their phone number.
 *
 * Not per cart or per visit: the caller rings a person once and asks about
 * what they left behind, so a second attempt an hour later should replace the
 * first rather than sit beside it.
 *
 * The reshaping is lib/phone's, deliberately — a second normaliser here would
 * eventually disagree with it, and the two are compared: the call list matches
 * a lead's phone against Customer.phone through that one. What is added is a
 * strictness lib/phone does not have, and should not: it is conservative on
 * unrecognised shapes, keeping their digits, whereas this is a database key
 * that every keystroke of a half-typed number reaches. Anything that is not a
 * callable Bangladeshi mobile has to be refused rather than stored.
 */
export function normalisePhone(raw: string): string | null {
  const normalized = normalizePhone(raw);
  return normalized && /^01[3-9]\d{8}$/.test(normalized) ? normalized : null;
}

/** "Magnatic Bar Blocks (42Pcs) x2, Zayan Talking Flash Cards x1" */
export function cartItemsText(items: CartSnapshotItem[]): string {
  return items
    .map((i) => `${(i.name ?? "Item").trim()} x${Math.max(1, Math.trunc(i.quantity ?? 1))}`)
    .join(", ");
}
