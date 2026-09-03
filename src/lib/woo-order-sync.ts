/**
 * Push a sale's outcome back to the website it may have come from.
 *
 * Every order that started as a WooCommerce checkout arrives here as an
 * OrderLead (source "WOOCOMMERCE", externalId = the Woo order id), and once a
 * real order is entered from it the lead is pointed at that order (see
 * linkLeadToOrder). That link is the only place a Woo order id lives — Order
 * itself carries none — so it is also the only way back.
 *
 * An order with no such lead is not necessarily wrong: a phone order, a
 * Facebook DM, a referral, or anything entered before the lead pipeline
 * existed has nothing on the website to update. Those are skipped, silently
 * here and counted by the backfill script — never guessed at by matching
 * phone or date, which risks writing a status onto a stranger's order.
 *
 * Best-effort throughout: a website that is slow or down must delay nothing
 * on the sales page, and must never turn an order status change here into a
 * failure the person clicking the dropdown has to deal with.
 */

import { prisma } from "@/lib/prisma";
import { wooAdminConfigured, wooFetch } from "@/lib/woo-catalog";

/** The two gedusuite outcomes this pushes, and what WooCommerce calls them. */
const WOO_STATUS = {
  DELIVERED: "completed",
  CANCELLED: "cancelled",
} as const;

/**
 * Woo states a push must never overwrite.
 *
 * A refund or a cancellation typed on the website itself is the one record of
 * money actually going back to a customer — a courier's "delivered" answer
 * (or a stale retry landing after somebody already fixed it in wp-admin) must
 * not roll that back to "completed". The reverse guard exists for the same
 * reason in the other direction.
 */
const WONT_OVERRIDE: Record<string, readonly string[]> = {
  completed: ["refunded", "cancelled", "failed"],
  cancelled: ["refunded", "completed"],
};

async function wooOrderIdFor(orderId: string): Promise<number | null> {
  const lead = await prisma.orderLead.findFirst({
    where: { orderId, source: "WOOCOMMERCE" },
    select: { externalId: true },
  });
  if (!lead) return null;
  const id = Number(lead.externalId);
  return Number.isFinite(id) ? id : null;
}

/**
 * Set once outside the DB write: two status changes seconds apart for the
 * same order (a retry, a second cron tick) should not race each other's Woo
 * calls or double-log a failure.
 */
const inFlight = new Set<string>();

/**
 * Mirror a DELIVERED or CANCELLED outcome to the WooCommerce order this
 * gedusuite order came from, if any. Fire from every code path that can set
 * one of those two statuses — the manual dropdown and the automatic courier
 * sync both change Order.status directly, so both call this.
 *
 * Never throws. Await it anyway: Vercel does not promise a fire-and-forget
 * call finishes after the response goes out.
 */
export async function syncOrderStatusToWoo(
  orderId: string,
  status: "DELIVERED" | "CANCELLED",
): Promise<void> {
  if (!wooAdminConfigured()) return;
  if (inFlight.has(orderId)) return;
  inFlight.add(orderId);

  try {
    const wooId = await wooOrderIdFor(orderId);
    if (wooId == null) return;

    const target = WOO_STATUS[status];
    const current = await wooFetch<{ status: string }>(`/orders/${wooId}`);
    if (current.status === target) return;
    if (WONT_OVERRIDE[target]?.includes(current.status)) return;

    await wooFetch(`/orders/${wooId}`, {
      method: "PUT",
      body: JSON.stringify({ status: target }),
    });
  } catch (e) {
    // The website being unreachable, or the order having vanished there,
    // costs a stale status shown to a customer — never a broken sale here.
    console.error(`[woo-order-sync] order ${orderId} -> ${status} failed:`, e);
  } finally {
    inFlight.delete(orderId);
  }
}
