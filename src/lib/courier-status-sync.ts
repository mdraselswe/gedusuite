import { prisma } from "@/lib/prisma";
import { loadCourierCredentials } from "@/lib/courier-credentials";
import { statusByConsignment } from "@/lib/steadfast";
import { recordSystemActivity } from "@/lib/activity";

/**
 * Ask the courier where each parcel in flight has got to.
 *
 * The webhook next door was built to be told this and, on this account, never
 * is: across fifty parcels it has only ever carried `in_review`, which
 * Steadfast sends when it accepts a booking. Thirty-three of those have since
 * been delivered and not one said so, so every DELIVERED here has been typed by
 * a person reading another app. The status endpoint answers correctly for the
 * same parcels — the news exists, it just has to be fetched.
 *
 * One function, two callers: a nightly cron and the sales page opening. Vercel's
 * Hobby plan allows a single cron run a day, which is too slow to be the only
 * way this happens, and a page that is open is a page somebody is about to make
 * a decision on. The same arrangement the call list already uses for pulling
 * abandoned checkouts, for the same reason.
 */

/** In flight: booked, gone, and not yet settled either way. */
const IN_FLIGHT = ["CONFIRMED", "PACKED", "SHIPPED"] as const;

export type CourierStatusSync = { checked: number; changed: number; delivered: number; slugs: string[] };

export async function syncCourierStatuses(opts: {
  /** Limit to one workspace — the page-driven call. Omitted, every workspace. */
  workspaceId?: string;
  /** A ceiling on a bad day; a normal run is a handful of calls. */
  max: number;
  /** Skip couriers asked about within this many ms. The cron passes nothing. */
  throttleMs?: number;
}): Promise<CourierStatusSync> {
  // Which couriers are due. Stamped before the calls rather than after, so two
  // page views a second apart don't both get through while the first is still
  // waiting on the courier.
  const due = await prisma.courier.findMany({
    where: {
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      apiKeyEnc: { not: null },
      ...(opts.throttleMs
        ? {
            OR: [
              { statusSyncedAt: null },
              { statusSyncedAt: { lt: new Date(Date.now() - opts.throttleMs) } },
            ],
          }
        : {}),
    },
    select: { id: true },
  });
  if (due.length === 0) return { checked: 0, changed: 0, delivered: 0, slugs: [] };
  const dueIds = due.map((c) => c.id);
  await prisma.courier.updateMany({
    where: { id: { in: dueIds } },
    data: { statusSyncedAt: new Date() },
  });

  const orders = await prisma.order.findMany({
    where: {
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      deliveryType: "COURIER",
      status: { in: [...IN_FLIGHT] },
      courierTrackingId: { not: null },
      courierId: { in: dueIds },
    },
    orderBy: { date: "asc" },
    take: opts.max,
    select: {
      id: true,
      courierId: true,
      courierTrackingId: true,
      courierStatus: true,
      status: true,
      // Read so delivery can settle the payment too — see the update below.
      paymentMethod: true,
      paymentStatus: true,
      cashInTreasury: true,
      workspaceId: true,
      customer: { select: { name: true } },
      courier: { select: { name: true } },
      workspace: { select: { slug: true } },
    },
  });

  // One decryption per courier rather than per parcel.
  const creds = new Map<string, Awaited<ReturnType<typeof loadCourierCredentials>>>();
  const slugs = new Set<string>();
  let checked = 0;
  let changed = 0;
  let delivered = 0;

  for (const order of orders) {
    if (!order.courierId || !order.courierTrackingId) continue;
    if (!creds.has(order.courierId)) {
      creds.set(order.courierId, await loadCourierCredentials(order.courierId));
    }
    const c = creds.get(order.courierId);
    if (!c) continue;

    const res = await statusByConsignment(c, order.courierTrackingId);
    checked += 1;
    if (!res.ok) continue;
    const status = res.data.trim().toLowerCase();
    if (!status || status === order.courierStatus) continue;

    changed += 1;
    slugs.add(order.workspace.slug);

    // Delivered is the one answer that moves the order by itself. It consumes
    // no stock that isn't already consumed — SHIPPED holds the same units — and
    // it needs no figure nobody has. Cancelled and partial_delivered stay a
    // person's call: both turn on money the courier never reports, what the
    // return trip cost and what was handed over at the door.
    const applies = status === "delivered" && order.status !== "DELIVERED";

    /**
     * Delivered means paid, on a parcel the courier collects for.
     *
     * "Delivered" is not an opinion about the goods — for a COD parcel it is
     * the courier saying it took the money at the door. A parcel that came
     * back with only the shipping is `partial_delivered`, which this sync
     * deliberately leaves to a person, so the two cases can't be confused.
     *
     * Left as UNPAID, the order sat in a blind spot between two pages that
     * were both right: the courier balance ignores payment status, so it
     * showed the 2,505 Steadfast was holding, while the treasury's "with the
     * courier" reads paidNotDeposited — which wants PAID or PARTIAL — and
     * showed 4.95 of it. Same money, two screens, and the only thing between
     * them was somebody remembering to change a dropdown.
     *
     * It also stops a delivered parcel being chased: an UNPAID one counts
     * towards what customers owe and towards the cash its holder is carrying,
     * and the customer paid and the holder is a courier.
     *
     * Narrow on purpose. Only what the courier collects for, only from UNPAID
     * (never overriding a typed PARTIAL), and never on an order whose cash is
     * already banked — that one would need its treasury entry recomputed, and
     * a background job is the wrong place to be moving money.
     */
    const settles =
      applies &&
      order.paymentMethod === "COURIER_COLLECTION" &&
      order.paymentStatus === "UNPAID" &&
      !order.cashInTreasury;

    await prisma.order.update({
      where: { id: order.id },
      data: {
        courierStatus: status,
        courierStatusAt: new Date(),
        ...(applies ? { status: "DELIVERED" as const } : {}),
        ...(settles ? { paymentStatus: "PAID" as const } : {}),
      },
    });
    if (applies) delivered += 1;

    await recordSystemActivity(order.workspaceId, order.courier?.name ?? "Courier", {
      action: "UPDATE",
      entity: "Order",
      entityId: order.id,
      entityLabel: order.customer?.name ?? order.courierTrackingId,
      summary: settles
        ? "Courier says: delivered — order marked delivered and paid"
        : applies
          ? "Courier says: delivered — order marked delivered"
          : `Courier says: ${status}`,
    });
  }

  return { checked, changed, delivered, slugs: [...slugs] };
}
