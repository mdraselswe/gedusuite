/**
 * What booking a parcel with a courier needs from a courier, whichever it is.
 *
 * Steadfast is wired in today (lib/steadfast, actions/courier-booking). This is
 * the shape a second courier has to fill so that the booking screen, the
 * status refresh and the cash reconciliation can stop naming Steadfast.
 * Nothing calls it yet — see docs/SAAS_UPGRADE_LOG.md, phase 6, for why.
 */
export type ParcelRequest = {
  /** Our own reference, unique per parcel — the courier shows it back to us. */
  reference: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  /** Cash the rider must collect, in taka. Zero for a prepaid parcel. */
  cashToCollect: number;
  weightKg: number;
  itemCount: number;
  description?: string;
  note?: string;
};

export type BookedParcel = {
  /** The courier's own id for the parcel. */
  consignmentId: string;
  trackingCode?: string;
  /** What the courier quoted for delivery, when it says so up front. */
  deliveryFee?: number;
};

export type ParcelStatus = {
  /** The courier's own words, stored verbatim. */
  raw: string;
  /** Our reading of it. */
  state: "pending" | "in_transit" | "delivered" | "returned" | "cancelled" | "on_hold" | "unknown";
};

export type ProviderResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface CourierProvider {
  readonly key: string;
  readonly label: string;
  book(req: ParcelRequest): Promise<ProviderResult<BookedParcel>>;
  status(consignmentId: string): Promise<ProviderResult<ParcelStatus>>;
}
