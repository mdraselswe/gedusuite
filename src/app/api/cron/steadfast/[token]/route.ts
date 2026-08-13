import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { courierByWebhookToken, webhookSecretMatches } from "@/lib/courier-credentials";
import { recordSystemActivity } from "@/lib/activity";

/**
 * Steadfast delivery-status webhook.
 *
 * Parked under /api/cron for the same reason the WooCommerce hook is: proxy.ts
 * already treats that prefix as public, so nothing in the auth gate has to
 * change to let a caller through that carries no session cookie.
 *
 * Auth is the token in the path. Steadfast's portal takes a webhook URL and
 * the documentation says nothing about signing the body or sending a shared
 * header, so a secret that survives however it chooses to call is a secret in
 * the URL. It is 128 bits of random and rotating it is a button in settings.
 *
 * What this writes is deliberately small: courierStatus and courierStatusAt,
 * and nothing else. It does NOT move the order's own status. updateOrderStatus
 * consumes stock, re-quotes the COD fee, and on a cancellation needs figures
 * no webhook can know — what the return trip cost, and what the customer
 * handed over at the door for a parcel they refused. Writing those as zero
 * because a POST arrived would put a wrong number into the profit reports and
 * leave nobody with a reason to doubt it. So the courier's word is recorded
 * here, shown as a badge, and applied by a person.
 */

/** Statuses Steadfast is documented to send. Anything else is stored verbatim. */
const KNOWN = new Set([
  "pending",
  "in_review",
  "delivered",
  // Undocumented, and sent: the rider has reported delivery and the office has
  // not signed it off yet. Listed so the history stops calling it unrecognised.
  "delivered_approval_pending",
  "partial_delivered",
  "cancelled",
  "hold",
  "unknown",
]);

type Payload = {
  consignment_id?: number | string;
  invoice?: string;
  tracking_code?: string;
  status?: string;
  delivery_status?: string;
  notification_type?: string;
  cod_amount?: number | string;
  updated_at?: string;
};

/**
 * Saving a webhook URL makes the portal check that something answers there,
 * and it refuses to save unless it gets a 200 — the same behaviour the
 * WooCommerce hook next door already has to live with. What it sends to check
 * is not documented, so every shape that carries no delivery news is answered
 * cheerfully: a GET, a HEAD, an empty POST, a body that is not JSON, a payload
 * naming no parcel.
 *
 * None of those write anything, which is what makes answering them safe. The
 * bearer token is still required by everything that does.
 */
const PONG = { ok: true, pong: true };

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const courier = await courierByWebhookToken(token);
  if (!courier) {
    return NextResponse.json({ error: "Unknown webhook token" }, { status: 404 });
  }
  return NextResponse.json(PONG);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;

  const courier = await courierByWebhookToken(token);
  if (!courier) {
    return NextResponse.json({ error: "Unknown webhook token" }, { status: 404 });
  }
  const workspaceSlug = courier.workspace.slug;

  // An unreadable or empty body is a probe, not news. Answered before the
  // auth check on purpose: the portal validates the URL at the moment it is
  // saved, which may well be before it starts sending the token it is being
  // given on the same screen.
  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return NextResponse.json(PONG);
  }
  if (!body || typeof body !== "object") return NextResponse.json(PONG);

  const consignmentId = body.consignment_id != null ? String(body.consignment_id) : null;
  if (!consignmentId && !body.invoice) {
    return NextResponse.json(PONG);
  }

  const status = (body.delivery_status ?? body.status ?? "").trim().toLowerCase();
  if (!status) {
    return NextResponse.json({ ok: true, skipped: "no status in payload" });
  }

  // Past this line the request is asking to change an order, so the token in
  // the path — which only says which workspace this concerns — is no longer
  // enough. This is what says the caller is really the courier.
  //
  // A courier connected before this column existed has no secret stored, and
  // refusing its webhooks would break a working integration to add a check it
  // was never given the token for. Those fall back to the URL alone until the
  // API is reconnected, which mints one.
  if (courier.webhookSecret && !webhookSecretMatches(courier.webhookSecret, req.headers)) {
    return NextResponse.json({ error: "Bad auth token" }, { status: 401 });
  }

  // Matched on the consignment id this app stored when it booked the parcel,
  // and scoped to the courier the token belongs to — one workspace's token
  // must not be able to write another's orders.
  //
  // Invoice is only a fallback, and only for an invoice this app wrote. A
  // parcel booked by hand in the courier's app carries whatever invoice
  // somebody typed, and "1042" would otherwise match order #1042 here and
  // overwrite the status of a completely unrelated parcel.
  const matchedOrderNo = orderNoFromInvoice(body.invoice, workspaceSlug);
  if (!consignmentId && matchedOrderNo == null) {
    return NextResponse.json({ ok: true, skipped: "invoice not written by this app" });
  }

  const order = await prisma.order.findFirst({
    where: {
      workspaceId: courier.workspaceId,
      ...(consignmentId ? { courierTrackingId: consignmentId } : { orderNo: matchedOrderNo! }),
    },
    select: {
      id: true,
      orderNo: true,
      courierStatus: true,
      courierStatusAt: true,
      customer: { select: { name: true } },
    },
  });
  if (!order) {
    // 200, not 404: the parcel may genuinely have been booked from the courier's
    // own app, and a courier that gets errors back tends to stop calling.
    return NextResponse.json({ ok: true, skipped: "no matching order" });
  }

  if (order.courierStatus === status) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  // Webhooks retry and can arrive out of order. Without this, a redelivered
  // "in_review" from an hour ago lands after "delivered" and the badge walks
  // backwards — and somebody applies a status the parcel left behind.
  const stampedAt = parseDate(body.updated_at) ?? new Date();
  if (order.courierStatusAt && stampedAt < order.courierStatusAt) {
    return NextResponse.json({ ok: true, skipped: "older than the status already stored" });
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      courierStatus: status,
      courierStatusAt: stampedAt,
      ...(body.tracking_code ? { courierTrackingCode: body.tracking_code } : {}),
    },
  });

  await recordSystemActivity(courier.workspaceId, courier.name, {
    action: "UPDATE",
    entity: "Order",
    entityId: order.id,
    entityLabel: order.customer?.name ?? `Order ${order.orderNo ?? ""}`.trim(),
    summary: `Courier says: ${status}${KNOWN.has(status) ? "" : " (unrecognised status)"}`,
  });

  return NextResponse.json({ ok: true });
}

/**
 * "GEDUSHOP-1042" -> 1042, but only when the prefix is this workspace's own.
 *
 * Anchored on purpose. A looser "trailing digits" read would accept the bare
 * "1042" that somebody typed into the courier's app for an unrelated parcel,
 * and quietly move the status of order #1042 here.
 */
/** A usable Date, or null — `new Date("nonsense")` is an Invalid Date, not a throw. */
function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function orderNoFromInvoice(
  invoice: string | undefined,
  slug: string,
): number | null {
  if (!invoice) return null;
  const prefix = slug.trim().replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
  if (!prefix) return null;
  const m = new RegExp(`^${prefix}-(\\d+)$`, "i").exec(invoice.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
