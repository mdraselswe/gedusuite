/**
 * What the courier last said about a parcel.
 *
 * Stored on Order.courierStatus as the courier's own string, not an enum, so a
 * status Steadfast adds later still lands rather than failing a write. Which is
 * why everything that reads it falls back to the raw value, and why the list of
 * known ones lives here: the sales filter has to offer them, and the badge has
 * to name them, and those two drifting apart is how a filter ends up offering a
 * status the list can't show.
 */

/** The ones seen in the wild, in the order a parcel passes through them. */
export const COURIER_STATUSES = [
  "in_review",
  "pending",
  "hold",
  "delivered_approval_pending",
  "delivered",
  "partial_delivered",
  "cancelled",
  "unknown",
] as const;

export type CourierStatus = (typeof COURIER_STATUSES)[number];

export function isCourierStatus(v: unknown): v is CourierStatus {
  return typeof v === "string" && (COURIER_STATUSES as readonly string[]).includes(v);
}

/**
 * The courier's own vocabulary, in this app's words.
 *
 * Steadfast's status list and this app's order statuses share the word
 * "pending" and mean opposite things by it: to the courier a pending parcel has
 * been accepted and is moving, to the order list a pending order is one nobody
 * has done anything with yet. Both would have sat on the same row — Status
 * "Packed", courier "Pending" — which is a screen that has to be explained
 * every time somebody new reads it.
 *
 * So the courier's answer is translated rather than prettified. Only the
 * wording changes; the stored status stays the courier's own, and everything
 * that decides anything — the apply rule, the tones, the payout import — still
 * reads that.
 *
 * "Delivered" is deliberately the same word in both: there the two really do
 * mean one thing, and inventing a difference would be its own confusion.
 */
export const COURIER_STATUS_LABEL: Record<string, string> = {
  in_review: "Booked",
  pending: "In transit",
  delivered: "Delivered",
  // Not in Steadfast's documented list, but it sends it: the rider has
  // reported the parcel delivered and the office has not signed it off. The
  // money is not settled and the parcel can still come back, so it reads as
  // what it is and moves nothing by itself.
  delivered_approval_pending: "Delivered, awaiting approval",
  partial_delivered: "Partly delivered",
  cancelled: "Returned",
  hold: "On hold",
  unknown: "No update",
};

/** How each courier status reads, and how loudly. */
export const COURIER_STATUS_TONE: Record<string, string> = {
  delivered: "text-emerald-600 dark:text-emerald-400",
  // Amber, with the others that aren't final yet.
  delivered_approval_pending: "text-amber-600 dark:text-amber-400",
  partial_delivered: "text-amber-600 dark:text-amber-400",
  cancelled: "text-destructive",
  hold: "text-amber-600 dark:text-amber-400",
};

/**
 * A parcel nobody has heard anything about — booked or not, the courier has
 * said nothing. Its own filter value, because "not delivered yet" and "we never
 * asked the courier" are different problems and only one of them is the
 * courier's. Distinct from the courier's own "unknown", which is an answer.
 */
export const NO_COURIER_STATUS = "__none__";
