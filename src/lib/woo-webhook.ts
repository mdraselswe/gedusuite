import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { upsertLeadFromWooOrder, type WooOrder } from "@/lib/woo";
import { recordSystemActivity } from "@/lib/activity";

/**
 * The part of the WooCommerce order webhook that does not depend on WHICH
 * workspace it is for. The original single-shop route (/api/cron/woo-lead,
 * secret and workspace from the environment) and the per-workspace route
 * (/api/hooks/woo/[token], secret and workspace from the database) both end
 * up here, so a webhook-delivered order produces the same row either way.
 */

/** WooCommerce signs the raw body; parsing first would change the bytes. */
export function wooSignatureMatches(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Saving a webhook makes WooCommerce call deliver_ping(), which posts the form
 * body "webhook_id=N" with NO signature header, and refuses to activate the
 * webhook unless it gets a 200 back. Answering costs nothing: the body carries
 * no data and nothing runs after it.
 */
export function isWooPing(raw: string) {
  return /^webhook_id=\d+$/.test(raw.trim());
}

export async function processWooOrderWebhook(
  workspaceId: string,
  raw: string,
): Promise<NextResponse> {
  let order: WooOrder;
  try {
    order = JSON.parse(raw) as WooOrder;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!order.id) return NextResponse.json({ ok: true, skipped: "ping" });

  const lead = await upsertLeadFromWooOrder(workspaceId, order, JSON.parse(raw));

  // Nobody was logged in, and the call list gained a row. A history with a
  // gap where the shop's own website writes data is a history that can't be
  // trusted to be complete.
  if (lead) {
    await recordSystemActivity(workspaceId, "WooCommerce", {
      action: "CREATE",
      entity: "OrderLead",
      entityId: lead.id,
      entityLabel: lead.customerName,
      summary: `Website order #${order.number ?? order.id} arrived in the call list`,
    });
  }

  return NextResponse.json({ ok: true });
}
