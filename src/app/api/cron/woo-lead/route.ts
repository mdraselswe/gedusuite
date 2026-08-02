import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { upsertLeadFromWooOrder, type WooOrder } from "@/lib/woo";

/**
 * WooCommerce order webhook -> the call list.
 *
 * Deliberately parked under /api/cron: proxy.ts already treats that prefix as
 * public, so nothing in the auth gate has to change to let WooCommerce (which
 * carries no session cookie) through. Auth is WooCommerce's own HMAC instead.
 *
 * This only ever writes OrderLead. No Order, no stock, no treasury — the real
 * order is still entered by hand on the sales page. Order parsing lives in
 * lib/woo so the pull-based sync produces byte-identical rows.
 */

/** WooCommerce signs the raw body; parsing first would change the bytes. */
function signatureMatches(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
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

  await upsertLeadFromWooOrder(workspace.id, order, JSON.parse(raw));

  return NextResponse.json({ ok: true });
}
