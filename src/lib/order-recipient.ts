/**
 * Who a parcel was actually addressed to.
 *
 * An order's delivery details are a snapshot taken when it was entered, not a
 * live read of the customer record. The two answer different questions: the
 * customer row is the buyer's identity — one per phone number, so their order
 * history, dues and repeat-buyer count hold together — while this is where one
 * particular box was sent.
 *
 * Reading the address off the customer record made both answers wrong as soon
 * as somebody ordered again to a different address. Leaving the record alone
 * printed the old address on the new parcel; updating it rewrote every past
 * order to an address it was never sent to, including any invoice reprinted
 * afterwards.
 *
 * Falls back to the customer for orders taken before the snapshot existed, and
 * for the ordinary order that just uses the customer's own details — so a
 * corrected typo in a customer record still reaches the documents that never
 * had anything different to say.
 */

export type RecipientSource = {
  shipName?: string | null;
  shipPhone?: string | null;
  shipAddress?: string | null;
  customer?: { name: string; phone: string | null; address: string | null } | null;
};

export type Recipient = {
  name: string | null;
  phone: string | null;
  address: string | null;
};

const pick = (snapshot?: string | null, fallback?: string | null): string | null => {
  const s = snapshot?.trim();
  if (s) return s;
  const f = fallback?.trim();
  return f || null;
};

/**
 * Field by field rather than all-or-nothing: an order that overrides only the
 * address should still show the customer's name, not a blank one.
 */
export function orderRecipient(order: RecipientSource): Recipient {
  return {
    name: pick(order.shipName, order.customer?.name),
    phone: pick(order.shipPhone, order.customer?.phone),
    address: pick(order.shipAddress, order.customer?.address),
  };
}

/**
 * True when this order was sent somewhere other than what the customer record
 * now says — the case worth flagging in the UI, because it's the one where the
 * two used to silently disagree.
 */
export function hasOwnAddress(order: RecipientSource): boolean {
  const snapshot = order.shipAddress?.trim();
  if (!snapshot) return false;
  return snapshot !== (order.customer?.address?.trim() ?? "");
}
