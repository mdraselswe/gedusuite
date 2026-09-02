import { prisma } from "@/lib/prisma";
import {
  ABANDON_AFTER_MS,
  CART_SOURCE,
  CART_STATUS,
  cartItemsText,
  normalisePhone,
  type CartSnapshot,
} from "@/lib/abandoned-cart";

/**
 * Writing abandoned carts into the call list.
 *
 * Split from lib/abandoned-cart because that half is imported by the call
 * list, which is a client component — Prisma must not follow it into the
 * browser bundle. The vocabulary and the pure helpers live there; everything
 * that touches the database lives here.
 */

const join = (...parts: (string | undefined)[]) =>
  parts
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(", ");

/**
 * Store (or refresh) one abandoned cart.
 *
 * Returns null when there is nothing callable — no valid phone, or an empty
 * cart. A row with neither is not a lead, it is noise in the call list.
 *
 * The update deliberately writes only what the customer typed: call status,
 * attempts, who called, the customer's advice and the linked customer all
 * survive, for the same reason the WooCommerce upsert protects them. Somebody
 * typing one more letter of their address must not undo the note written after
 * ringing them.
 */
export async function upsertAbandonedCart(workspaceId: string, snap: CartSnapshot) {
  const phone = normalisePhone(snap.phone ?? "");
  if (!phone) return null;

  const items = (snap.items ?? []).filter((i) => (i.name ?? "").trim());
  if (!items.length) return null;

  // Already ordered under this number, so the cart is not abandoned — they
  // finished. Checked here as well as on the order side because the two arrive
  // in either order: a slow webhook can land after the last keystroke.
  const ordered = await prisma.orderLead.findFirst({
    where: { workspaceId, phone, source: { not: CART_SOURCE } },
    select: { id: true },
  });
  if (ordered) return null;

  const total =
    typeof snap.total === "number" && Number.isFinite(snap.total) && snap.total > 0
      ? snap.total
      : items.reduce((sum, i) => sum + (Number(i.lineTotal) || 0), 0);

  const fields = {
    customerName: (snap.name ?? "").trim() || "Unknown",
    phone,
    address: join(snap.address, snap.area, snap.district) || null,
    itemsText: cartItemsText(items),
    total,
    // When they were last seen, which is what the caller reads and what the
    // list's cutoff is measured from — not when the row happened to be written.
    orderedAt: new Date(),
    wooStatus: CART_STATUS,
    rawPayload: snap as never,
  };

  return prisma.orderLead.upsert({
    where: {
      workspaceId_source_externalId: { workspaceId, source: CART_SOURCE, externalId: phone },
    },
    create: { workspaceId, source: CART_SOURCE, externalId: phone, channel: "WEBSITE", ...fields },
    update: fields,
  });
}

/**
 * Drop the abandoned-cart row for somebody who has now ordered.
 *
 * Called from both paths that learn about a real order — the WooCommerce
 * webhook and the pull sync — so the call list never shows "they left this
 * behind" next to an order that was actually placed.
 */
export async function clearAbandonedCartFor(workspaceId: string, rawPhone: string) {
  const phone = normalisePhone(rawPhone);
  if (!phone) return;
  await prisma.orderLead.deleteMany({
    where: { workspaceId, source: CART_SOURCE, externalId: phone },
  });
}

/** Long enough to read in a notification, short enough not to fill the bell. */
function shortItems(itemsText: string) {
  return itemsText.length > 70 ? `${itemsText.slice(0, 67)}…` : itemsText;
}

/**
 * Raise (and retire) the bell alerts for carts nobody has rung yet.
 *
 * There is no scheduler fine-grained enough to notice a cart going quiet — the
 * plan's crons run daily, and half an hour is the window that matters. So this
 * follows what the courier sync already does about the same problem: it runs
 * on the paths that are busy anyway. The beacon calls it, which means it runs
 * whenever anybody is shopping, and the call list calls it on open.
 *
 * Idempotent. dedupeKey is the lead's own id, so a cart that is swept twenty
 * times still has one notification, and refreshing a stale one costs nothing.
 */
export async function refreshAbandonedCartAlerts(workspaceId: string) {
  const [workspace, ready] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }),
    prisma.orderLead.findMany({
      where: {
        workspaceId,
        source: CART_SOURCE,
        // Quiet long enough to count as walked away from.
        orderedAt: { lte: new Date(Date.now() - ABANDON_AFTER_MS) },
        // Once somebody has picked the row up, the bell has done its job.
        callStatus: "NOT_CALLED",
      },
      select: { id: true, customerName: true, total: true, itemsText: true },
      // A shop that has been closed for a week should not open to two hundred
      // unread rows. The oldest carts are the coldest calls anyway.
      orderBy: { orderedAt: "desc" },
      take: 30,
    }),
  ]);

  const link = workspace ? `/${workspace.slug}/leads` : null;
  const liveKeys = ready.map((l) => `abandoned-cart:${l.id}`);

  await prisma.$transaction([
    ...ready.map((l) => {
      const dedupeKey = `abandoned-cart:${l.id}`;
      const name = l.customerName && l.customerName !== "Unknown" ? l.customerName : "Someone";
      const message = `${name} left ৳${Number(l.total).toLocaleString("en-BD")} in their cart — ${shortItems(l.itemsText)}`;
      return prisma.notification.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        create: { workspaceId, type: "GENERAL", message, link, dedupeKey },
        update: { message, link },
      });
    }),
    // Carts that have since been ordered, called or deleted. Leaving these
    // would send somebody to a row that is no longer there.
    prisma.notification.deleteMany({
      where: {
        workspaceId,
        dedupeKey: { startsWith: "abandoned-cart:", notIn: liveKeys.length ? liveKeys : ["__none__"] },
      },
    }),
  ]);
}
