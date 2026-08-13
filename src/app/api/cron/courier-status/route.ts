import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { denyCron } from "@/lib/cron-auth";
import { loadCourierCredentials } from "@/lib/courier-credentials";
import { statusByConsignment } from "@/lib/steadfast";
import { recordSystemActivity } from "@/lib/activity";

/**
 * Ask the courier where each parcel in flight has got to.
 *
 * The webhook next door was built to be told this, and in practice never is:
 * across fifty parcels it has only ever delivered `in_review`, which Steadfast
 * sends when it accepts a booking. Thirty-three of those parcels have since
 * been delivered and not one said so, so every DELIVERED in this app has been
 * typed by a person watching another app. The status endpoint, meanwhile,
 * answers correctly for the same parcels — so the news exists, it just has to
 * be fetched rather than waited for.
 *
 * The webhook stays. When it does fire it is instant, both write the same two
 * fields, and both refuse to move backwards in time — whichever hears first
 * wins and the other becomes a no-op.
 *
 * Only parcels actually in flight are asked about, which keeps a run to a
 * handful of calls: a delivered or cancelled order is finished, and one with
 * no consignment id was never booked through anybody's API.
 */
export const dynamic = "force-dynamic";

/** In flight: booked, gone, and not yet settled either way. */
const IN_FLIGHT = ["CONFIRMED", "PACKED", "SHIPPED"] as const;

/** Enough per run for a shop's daily volume, and a ceiling on a bad day. */
const MAX_PER_RUN = 80;

export async function GET(req: NextRequest) {
  const denied = denyCron(req);
  if (denied) return denied;

  const orders = await prisma.order.findMany({
    where: {
      deliveryType: "COURIER",
      status: { in: [...IN_FLIGHT] },
      courierTrackingId: { not: null },
      courier: { apiKeyEnc: { not: null } },
    },
    orderBy: { date: "asc" },
    take: MAX_PER_RUN,
    select: {
      id: true,
      courierId: true,
      courierTrackingId: true,
      courierStatus: true,
      status: true,
      workspaceId: true,
      customer: { select: { name: true } },
      courier: { select: { name: true } },
      workspace: { select: { slug: true } },
    },
  });

  // One decryption per courier rather than per parcel.
  const creds = new Map<string, Awaited<ReturnType<typeof loadCourierCredentials>>>();
  const touchedSlugs = new Set<string>();
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
    touchedSlugs.add(order.workspace.slug);

    // Delivered is the one answer that moves the order by itself. It consumes
    // no stock that isn't already consumed — SHIPPED holds the same units — and
    // it needs no figure nobody has. Cancelled and partial_delivered stay a
    // person's call: both turn on money the courier never reports, what the
    // return trip cost and what was handed over at the door.
    const applies = status === "delivered" && order.status !== "DELIVERED";
    await prisma.order.update({
      where: { id: order.id },
      data: {
        courierStatus: status,
        courierStatusAt: new Date(),
        ...(applies ? { status: "DELIVERED" as const } : {}),
      },
    });
    if (applies) delivered += 1;

    await recordSystemActivity(order.workspaceId, order.courier?.name ?? "Courier", {
      action: "UPDATE",
      entity: "Order",
      entityId: order.id,
      entityLabel: order.customer?.name ?? order.courierTrackingId,
      summary: applies
        ? `Courier says: delivered — order marked delivered`
        : `Courier says: ${status}`,
    });
  }

  for (const slug of touchedSlugs) {
    revalidatePath(`/${slug}/sales/orders`);
    revalidatePath(`/${slug}/couriers`);
    revalidatePath(`/${slug}/treasury`);
  }

  return NextResponse.json({ ok: true, checked, changed, delivered });
}
