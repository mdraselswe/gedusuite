import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { isWooPing, processWooOrderWebhook, wooSignatureMatches } from "@/lib/woo-webhook";

/**
 * A workspace's own WooCommerce order webhook.
 *
 * The token in the path says WHICH workspace; the HMAC says it really came from
 * that shop's WooCommerce. Neither alone is enough, and neither is derived from
 * the other. Rotating from Settings -> Website invalidates both at once.
 *
 * Like the original /api/cron/woo-lead it only ever writes OrderLead.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const raw = await req.text();

  // Saving the webhook in WooCommerce pings the URL unsigned and refuses to
  // activate it without a 200 — see isWooPing. The token is still checked, so
  // the answer reveals nothing a stranger could not already see is 404.
  const row = await prisma.workspaceIntegration.findUnique({
    where: { hookToken: token },
    select: { workspaceId: true, wooWebhookSecretEnc: true },
  });
  if (!row) return NextResponse.json({ error: "Unknown webhook" }, { status: 404 });

  if (isWooPing(raw)) return NextResponse.json({ ok: true, pong: true });

  const secret = row.wooWebhookSecretEnc ? decrypt(row.wooWebhookSecretEnc) : null;
  if (!secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  if (!wooSignatureMatches(raw, req.headers.get("x-wc-webhook-signature"), secret)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  return processWooOrderWebhook(row.workspaceId, raw);
}
