import type { ActionFailure } from "@/lib/form";

/**
 * The rules about goods coming back, with neither the database nor React in
 * front of them.
 *
 * Both of these decide what happens to stock, and both were going to live
 * inside things that can't be tested: one in a "use server" module, the other
 * in a three-thousand-line dialog. The receive step in particular is the one
 * moment the shelf is written from a number a person typed rather than from
 * what the order says, so it is the one that has to be provably right.
 */

/**
 * Past this many days a parcel has stopped being "on its way" and started
 * being a question for the courier. Nothing is enforced at it — it just stops
 * a fortnight-old parcel from looking like this morning's.
 */
export const OVERDUE_RETURN_DAYS = 10;

/**
 * Where the cancellation dialog's "goods still with the courier" box starts.
 *
 * A guess, and only a guess — which is why it is a tick box and not a rule.
 * SHIPPED means the parcel left; PACKED with a consignment number means the
 * courier has booked it and is coming for it or already has. Everything else
 * — never packed, hand-delivered, packed and still on the table — means the
 * goods never went anywhere and belong back on the shelf immediately.
 */
export function goodsLikelyWithCourier(o: {
  status: string;
  deliveryType: string;
  courierTrackingId: string | null;
}): boolean {
  if (o.deliveryType !== "COURIER") return false;
  return o.status === "SHIPPED" || (o.status === "PACKED" && !!o.courierTrackingId);
}

/** One line of a parcel, as it left the shop. */
export type SentLine = {
  kind: "ITEM" | "GIFT";
  id: string;
  quantity: number;
};

/** What somebody counted back in against that line. */
export type ReceivedLine = {
  kind: "ITEM" | "GIFT";
  id: string;
  /** How many of it came back fit to sell. */
  good: number;
};

export type ShortfallResult =
  | {
      ok: true;
      /** Pieces to take back out of stock, per variant. */
      rows: { productVariantId: string; quantity: number }[];
      /** Everything the parcel carried, for the "N of M back" line. */
      total: number;
    }
  | ActionFailure;

/**
 * Turn "how many came back fit to sell" into the pieces that have to leave
 * stock again, per variant.
 *
 * Marking a parcel received restores its whole quantity by itself — the order
 * simply stops holding those units off the shelf — so what this computes is
 * the correction: the part that came back broken, or didn't come back at all.
 *
 * Refuses a line that claims more came back than went out, one that names
 * something the parcel never carried, and the same line twice. Each of those
 * is a way to type a phantom onto the shelf, and this is the only place in the
 * app where a person's count moves stock directly.
 *
 * A line left out is taken as having come back whole, which is what somebody
 * who only edited the one damaged row means.
 */
export function returnShortfalls(
  order: {
    items: { id: string; productVariantId: string; quantity: number }[];
    gifts: { id: string; productVariantId: string | null; quantity: number }[];
  },
  lines: ReceivedLine[],
): ShortfallResult {
  const sent = new Map<string, { productVariantId: string; quantity: number }>();
  for (const i of order.items) {
    sent.set(`ITEM:${i.id}`, { productVariantId: i.productVariantId, quantity: i.quantity });
  }
  for (const g of order.gifts) {
    // A custom free-text gift has no variant and so no stock to restore.
    if (!g.productVariantId) continue;
    sent.set(`GIFT:${g.id}`, { productVariantId: g.productVariantId, quantity: g.quantity });
  }

  const byVariant = new Map<string, number>();
  const seen = new Set<string>();
  for (const l of lines) {
    const key = `${l.kind}:${l.id}`;
    const line = sent.get(key);
    if (!line) return { ok: false, error: "That parcel never carried one of these lines." };
    if (seen.has(key)) return { ok: false, error: "The same line was counted twice." };
    seen.add(key);
    if (l.good > line.quantity) {
      return { ok: false, error: "More came back than went out — check the counts." };
    }
    const short = line.quantity - l.good;
    if (short > 0) {
      byVariant.set(line.productVariantId, (byVariant.get(line.productVariantId) ?? 0) + short);
    }
  }

  return {
    ok: true,
    rows: [...byVariant].map(([productVariantId, quantity]) => ({ productVariantId, quantity })),
    total: [...sent.values()].reduce((s, l) => s + l.quantity, 0),
  };
}
