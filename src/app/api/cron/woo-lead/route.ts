import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { isWooPing, processWooOrderWebhook, wooSignatureMatches } from "@/lib/woo-webhook";

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

export async function POST(req: NextRequest) {
  const secret = process.env.WOO_WEBHOOK_SECRET;
  const slug = process.env.WOO_WORKSPACE_SLUG;
  if (!secret || !slug) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const raw = await req.text();

  if (isWooPing(raw)) {
    return NextResponse.json({ ok: true, pong: true });
  }

  if (!wooSignatureMatches(raw, req.headers.get("x-wc-webhook-signature"), secret)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  const workspace = await prisma.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!workspace) {
    return NextResponse.json({ error: `Unknown workspace "${slug}"` }, { status: 500 });
  }

  return processWooOrderWebhook(workspace.id, raw);
}
