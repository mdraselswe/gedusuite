import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * WooCommerce order webhook -> the call list.
 *
 * Deliberately parked under /api/cron: proxy.ts already treats that prefix as
 * public, so nothing in the auth gate has to change to let WooCommerce (which
 * carries no session cookie) through. Auth is WooCommerce's own HMAC instead.
 *
 * This only ever writes OrderLead. No Order, no stock, no treasury — the real
 * order is still entered by hand on the sales page.
 */

const SOURCE = "WOOCOMMERCE";

/** WooCommerce signs the raw body; parsing first would change the bytes. */
function signatureMatches(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

type WooLineItem = {
  name?: string;
  quantity?: number;
  meta_data?: { key?: string; display_value?: string }[];
};
type WooOrder = {
  id?: number;
  number?: string;
  date_created?: string;
  date_created_gmt?: string;
  total?: string;
  billing?: Record<string, string | undefined>;
  shipping?: Record<string, string | undefined>;
  line_items?: WooLineItem[];
};

const join = (...parts: (string | undefined)[]) => parts.filter((p) => p && p.trim()).join(", ");

function addressOf(o: WooOrder) {
  // Shipping is what actually gets delivered to; fall back to billing, which
  // is all a Store API checkout fills in when shipping is left blank.
  const s = o.shipping ?? {};
  const b = o.billing ?? {};
  const pick = (k: string) => (s[k]?.trim() ? s[k] : b[k]);
  return join(pick("address_1"), pick("address_2"), pick("city"), pick("state")) || null;
}

function orderedAtOf(o: WooOrder) {
  const gmt = o.date_created_gmt;
  if (gmt) return new Date(gmt.endsWith("Z") ? gmt : `${gmt}Z`);
  if (o.date_created) return new Date(o.date_created);
  return new Date();
}

function itemsTextOf(o: WooOrder) {
  return (o.line_items ?? [])
    .map((li) => {
      // Underscore keys are WooCommerce's internal bookkeeping (_reduced_stock
      // and friends) — including them printed a stray "(1)" after every item.
      const variation = (li.meta_data ?? [])
        .filter((m) => m.key && !m.key.startsWith("_"))
        .map((m) => m.display_value)
        .filter(Boolean)
        .join(" / ");
      return `${li.name ?? "Item"}${variation ? ` (${variation})` : ""} x${li.quantity ?? 1}`;
    })
    .join(", ");
}

export async function POST(req: NextRequest) {
  const secret = process.env.WOO_WEBHOOK_SECRET;
  const slug = process.env.WOO_WORKSPACE_SLUG;
  if (!secret || !slug) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const raw = await req.text();

  // Saving a webhook makes WooCommerce call deliver_ping(), which posts the
  // form body "webhook_id=N" with NO signature header, and refuses to activate
  // the webhook unless it gets a 200 back. Answering it costs nothing: the
  // body carries no data and nothing below this line runs.
  if (/^webhook_id=\d+$/.test(raw.trim())) {
    return NextResponse.json({ ok: true, pong: true });
  }

  if (!signatureMatches(raw, req.headers.get("x-wc-webhook-signature"), secret)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  let order: WooOrder;
  try {
    order = JSON.parse(raw) as WooOrder;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!order.id) return NextResponse.json({ ok: true, skipped: "ping" });

  const workspace = await prisma.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!workspace) {
    return NextResponse.json({ error: `Unknown workspace "${slug}"` }, { status: 500 });
  }

  const b = order.billing ?? {};
  const s = order.shipping ?? {};
  const name =
    join(s.first_name, s.last_name).replace(", ", " ").trim() ||
    join(b.first_name, b.last_name).replace(", ", " ").trim() ||
    "Unknown";

  const fields = {
    orderNo: order.number ? `#${order.number}` : null,
    customerName: name,
    // Never drop an order for a missing phone — an empty cell is still callable
    // information ("no number given"), a 400 back to WooCommerce is not.
    phone: (b.phone ?? s.phone ?? "").trim(),
    address: addressOf(order),
    itemsText: itemsTextOf(order),
    total: order.total ? Number(order.total) : 0,
    // WooCommerce sends these without a timezone suffix, which new Date()
    // would read as the *server's* local time — six hours off here, enough to
    // date a morning order to the previous day. _gmt is unambiguous once
    // marked as UTC, and stays right even if the site's timezone changes.
    orderedAt: orderedAtOf(order),
    rawPayload: JSON.parse(raw),
  };

  // order.updated re-fires for the same id, so refresh the order data but leave
  // every call-tracking field alone — a status set by hand must survive.
  await prisma.orderLead.upsert({
    where: {
      workspaceId_source_externalId: {
        workspaceId: workspace.id,
        source: SOURCE,
        externalId: String(order.id),
      },
    },
    create: { workspaceId: workspace.id, source: SOURCE, externalId: String(order.id), ...fields },
    update: fields,
  });

  return NextResponse.json({ ok: true });
}
