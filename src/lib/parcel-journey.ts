/**
 * One order's journey, as five things that either happened or haven't.
 *
 * The change history answers "why does this order say what it says" and is the
 * right shape for that: every edit, in order, with who made it. It is the wrong
 * shape for "where is this parcel", which is the question actually asked while
 * a customer is on the phone — twelve rows including two campaign tags and a
 * source correction, to find one date.
 *
 * So this reads the same log and throws almost all of it away. Five steps, each
 * with a date or nothing, so what is missing shows up as a gap rather than as
 * an absence somebody has to notice.
 *
 * Derived rather than stored. Nothing here is a column the order could have
 * carried instead: a `bookedAt` would have to be written by every path that can
 * book, and would then be a second copy of a fact the log already holds and
 * would drift from it the first time one of those paths forgot.
 *
 * Read from `changes` where it exists — `{status: {to: "SHIPPED"}}` is a fact,
 * where the summary beside it is a sentence somebody may reword. The courier
 * sync writes no changes (it has nothing to diff against), so those steps fall
 * back to matching its wording, and to the order's own columns when even that
 * is missing.
 */

/** Enough of a log row to place it on the journey. */
export type JourneyActivity = {
  createdAt: Date;
  summary: string;
  changes: unknown;
  action: string;
};

/** Enough of an order to know which journey it is on. */
export type JourneyOrder = {
  createdAt: Date;
  status: string;
  deliveryType: string;
  courierTrackingId: string | null;
  courierStatus: string | null;
  courierStatusAt: Date | null;
  cashInTreasury: boolean;
  returnLeg: string;
  returnLegAt: Date | null;
  cancelledCollected: number;
};

export type JourneyStep = {
  key: "ordered" | "booked" | "shipped" | "arrived" | "settled";
  label: string;
  /** When it happened. Null on a step still ahead of the parcel. */
  at: Date | null;
  /**
   * True once the step is behind the parcel, even with no date. A tracking id
   * typed in by hand was booked; nothing recorded when. Saying "not booked"
   * there would be a worse answer than saying "booked, no time recorded".
   */
  done: boolean;
  /** The consignment number, what came back, what the courier last said. */
  detail?: string;
};

const statusTo = (a: JourneyActivity, to: string): boolean => {
  const c = a.changes as { status?: { to?: unknown } } | null | undefined;
  return c?.status?.to === to;
};

/** Earliest row that matches — a status can be set, undone and set again. */
function firstWhere(
  activity: JourneyActivity[],
  pred: (a: JourneyActivity) => boolean,
): Date | null {
  let found: Date | null = null;
  for (const a of activity) {
    if (!pred(a)) continue;
    if (!found || a.createdAt < found) found = a.createdAt;
  }
  return found;
}

/** Statuses a courier reports before it has tried to deliver. */
const PRE_DELIVERY = new Set(["pending", "in_review", "hold"]);

/**
 * What the last step is called depends on how the parcel ended, and a
 * cancellation has three endings that a single word cannot cover: the goods
 * came back, or the customer kept part of it and paid the shipping, or nobody
 * has said yet.
 */
function arrival(order: JourneyOrder): { label: string; detail?: string } {
  if (order.status !== "CANCELLED") return { label: "Delivered" };
  if (order.cancelledCollected > 0) {
    return {
      label: "Partly delivered",
      detail: "customer paid the shipping and refused the goods",
    };
  }
  switch (order.returnLeg) {
    case "RECEIVED":
      return { label: "Returned", detail: "goods back on the shelf" };
    case "IN_TRANSIT":
      return { label: "Returned", detail: "goods on their way back" };
    case "LOST":
      return { label: "Returned", detail: "goods never came back" };
    default:
      return { label: "Cancelled" };
  }
}

export function parcelJourney(
  order: JourneyOrder,
  activity: JourneyActivity[],
): JourneyStep[] {
  const courier = order.deliveryType === "COURIER";
  const cancelled = order.status === "CANCELLED";
  const end = arrival(order);

  // Created is the one step every order has, and the log always has it —
  // except on rows older than the audit trail, which fall back to the row's
  // own timestamp.
  const ordered =
    firstWhere(activity, (a) => a.action === "CREATE") ?? order.createdAt;

  const booked = firstWhere(activity, (a) => a.summary.startsWith("Booked with"));
  const shipped = firstWhere(
    activity,
    (a) => statusTo(a, "SHIPPED") || a.summary === "Status set to shipped",
  );

  // The earliest of every way delivery gets recorded, not the first way that
  // has a row. The courier saying "delivered" is the moment the customer took
  // the parcel; this app marking it delivered is the moment we heard, and on
  // one real parcel those were a day apart because the courier walked the
  // status back to approval-pending in between. The customer's date is the
  // true one. `=== "Courier says: delivered"` and not a prefix, because
  // "Courier says: delivered_approval_pending" starts with the same words and
  // means the opposite.
  const deliveredAt =
    firstWhere(
      activity,
      (a) =>
        statusTo(a, "DELIVERED") ||
        a.summary === "Courier says: delivered" ||
        a.summary.includes("marked delivered"),
    ) ?? (order.status === "DELIVERED" ? order.courierStatusAt : null);
  const cancelledAt =
    firstWhere(activity, (a) => statusTo(a, "CANCELLED")) ??
    (cancelled ? order.returnLegAt : null);

  // The banking action diffs `cashInTreasury`, so this one is a fact and not
  // a sentence. Which direction it went is only in the wording, and it decides
  // what the step is called: most parcels bring money in, a returned one only
  // ever costs the trip.
  const settleRow = activity
    .filter((a) => {
      const c = a.changes as { cashInTreasury?: { to?: unknown } } | null | undefined;
      return c?.cashInTreasury?.to === true;
    })
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
  const outward = settleRow?.summary.startsWith("Courier charges settled") ?? false;

  const steps: JourneyStep[] = [
    { key: "ordered", label: "Ordered", at: ordered, done: true },
  ];

  if (courier) {
    steps.push({
      key: "booked",
      label: "Booked with the courier",
      at: booked,
      // A tracking id is proof it was booked whatever the log says — it can
      // only have come from the courier.
      done: !!booked || !!order.courierTrackingId,
      detail: order.courierTrackingId ?? undefined,
    });
  }

  steps.push({
    key: "shipped",
    label: courier ? "Handed to the courier" : "Out for delivery",
    at: shipped,
    // Delivered without a recorded shipping is still shipped: the parcel
    // cannot have arrived without going.
    done: !!shipped || !!deliveredAt || order.status === "DELIVERED",
    detail:
      // What the courier last said, and only while the parcel is still in the
      // air. Once it has arrived — delivered, returned, refused — the step
      // below names that in words a person chose, and repeating the courier's
      // own "partial_delivered" above it says the same thing twice, worse.
      !deliveredAt &&
      !cancelled &&
      order.courierStatus &&
      !PRE_DELIVERY.has(order.courierStatus)
        ? order.courierStatus.replace(/_/g, " ")
        : undefined,
  });

  steps.push({
    key: "arrived",
    label: end.label,
    at: cancelled ? cancelledAt : deliveredAt,
    done: cancelled || order.status === "DELIVERED",
    detail: end.detail,
  });

  steps.push({
    key: "settled",
    // The journey the money makes, which does not end where the parcel does:
    // a courier holds the cash until its next payout, and "delivered" is the
    // step people mistake for "paid".
    label: outward ? "Courier charges paid" : "Money in the treasury",
    at: settleRow?.createdAt ?? null,
    done: order.cashInTreasury,
  });

  return steps;
}
