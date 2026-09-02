import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { refreshAbandonedCartAlerts, upsertAbandonedCart } from "@/lib/abandoned-cart-store";
import type { CartSnapshot } from "@/lib/abandoned-cart";

/**
 * The storefront's abandoned-cart beacon.
 *
 * Parked under /api/cron for the same reason the WooCommerce webhook is:
 * proxy.ts already treats that prefix as public, so nothing in the auth gate
 * has to change to let an unauthenticated caller through. Auth is an HMAC over
 * the raw body, exactly as WooCommerce signs its webhooks.
 *
 * The caller is a Cloudflare Pages Function on gedushop.com, never the
 * browser: the storefront is a static export, so a secret shipped to it would
 * be a secret published on the internet. The Function holds it at the edge.
 *
 * Writes nothing but OrderLead. No Order, no stock, no treasury — a cart
 * somebody walked away from is a phone call to make, not a sale that happened.
 */

function signatureMatches(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = process.env.CART_BEACON_SECRET;
  const slug = process.env.WOO_WORKSPACE_SLUG;
  if (!secret || !slug) {
    return NextResponse.json({ error: "Cart beacon not configured" }, { status: 503 });
  }

  const raw = await req.text();
  if (!signatureMatches(raw, req.headers.get("x-gedu-signature"), secret)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  let snap: CartSnapshot;
  try {
    snap = JSON.parse(raw) as CartSnapshot;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const workspace = await prisma.workspace.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!workspace) {
    return NextResponse.json({ error: `Unknown workspace "${slug}"` }, { status: 500 });
  }

  const lead = await upsertAbandonedCart(workspace.id, snap);

  // Somebody is shopping, so this is a good moment to notice the carts that
  // went quiet earlier. There is no cron fine-grained enough to do it — see
  // refreshAbandonedCartAlerts.
  await refreshAbandonedCartAlerts(workspace.id);

  // A rejected snapshot is the normal case, not a failure: every keystroke
  // before the phone number is complete arrives here and is dropped. Answering
  // 200 keeps the storefront from retrying something that will never differ.
  return NextResponse.json({ ok: true, stored: Boolean(lead) });
}
