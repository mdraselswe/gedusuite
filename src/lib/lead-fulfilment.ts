/**
 * Where a call-list lead's parcel got to.
 *
 * Read off the linked Order, never stored on the lead. The order already
 * tracks its own status, and a second copy on the lead would be one more
 * thing to remember to update — the two would disagree within a week, and
 * nobody could say which was right.
 *
 * RETURNED isn't an order status: returns are recorded per item, so an order
 * is "returned" when every unit sold has come back. A partial return leaves
 * the order where it was (usually DELIVERED) — some of it stayed sold.
 */

export const LEAD_FULFILMENTS = [
  "NOT_ENTERED",
  "PENDING",
  "CONFIRMED",
  "PACKED",
  "SHIPPED",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
] as const;

export type LeadFulfilment = (typeof LEAD_FULFILMENTS)[number];

export const LEAD_FULFILMENT_LABEL: Record<LeadFulfilment, string> = {
  NOT_ENTERED: "Not entered",
  PENDING: "Order pending",
  CONFIRMED: "Confirmed",
  PACKED: "Packed",
  SHIPPED: "With courier",
  DELIVERED: "Delivered",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
};

/**
 * Tints for the fulfilment badge.
 *
 * Every one sets its OWN background. Badge defaults to `bg-primary` with
 * white text, so a tone that only names a border and a text colour leaves a
 * solid purple chip with dark text on it — unreadable. Tailwind-merge keeps
 * whichever background is passed in here, so each state has to name one.
 *
 * Deliberately a different palette from the call-status column next to it:
 * two columns tinted the same way read as one repeated fact, which is exactly
 * the confusion this split is undoing.
 */
export const LEAD_FULFILMENT_TONE: Record<LeadFulfilment, string> = {
  // Not a failure — most of the list is legitimately here — but it IS the one
  // state the reader can act on, so it stays legible rather than fading out.
  NOT_ENTERED:
    "border-dashed border-muted-foreground/50 bg-transparent text-muted-foreground",
  PENDING: "border-muted-foreground/30 bg-muted text-foreground",
  CONFIRMED:
    "border-sky-500/40 bg-sky-500/15 text-sky-800 dark:bg-sky-500/25 dark:text-sky-200",
  PACKED:
    "border-indigo-500/40 bg-indigo-500/15 text-indigo-800 dark:bg-indigo-500/25 dark:text-indigo-200",
  SHIPPED:
    "border-violet-500/40 bg-violet-500/15 text-violet-800 dark:bg-violet-500/25 dark:text-violet-200",
  // The end of the happy path, so it's the one filled strongly enough to find
  // by colour alone when scanning a long list.
  DELIVERED:
    "border-emerald-600/50 bg-emerald-500/25 font-semibold text-emerald-900 dark:bg-emerald-500/30 dark:text-emerald-100",
  RETURNED:
    "border-orange-500/40 bg-orange-500/15 text-orange-800 dark:bg-orange-500/25 dark:text-orange-200",
  CANCELLED:
    "border-muted-foreground/30 bg-muted text-muted-foreground line-through",
};

/** The linked order, reduced to what the fulfilment state depends on. */
export type FulfilmentSource = {
  status: string;
  items: { quantity: number; returns: { quantity: number }[] }[];
};

export function leadFulfilment(order: FulfilmentSource | null | undefined): LeadFulfilment {
  if (!order) return "NOT_ENTERED";
  if (order.status === "CANCELLED") return "CANCELLED";

  const sold = order.items.reduce((s, it) => s + it.quantity, 0);
  const returned = order.items.reduce(
    (s, it) => s + it.returns.reduce((r, x) => r + x.quantity, 0),
    0,
  );
  if (sold > 0 && returned >= sold) return "RETURNED";

  return (LEAD_FULFILMENTS as readonly string[]).includes(order.status)
    ? (order.status as LeadFulfilment)
    : "PENDING";
}
