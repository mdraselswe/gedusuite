import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/crypto";
import { refreshAbandonedCartAlerts, upsertAbandonedCart } from "@/lib/abandoned-cart-store";
import type { CartSnapshot } from "@/lib/abandoned-cart";

/**
 * A workspace's own abandoned-cart beacon (the multi-shop twin of
 * /api/cron/abandoned-cart). Token picks the workspace, HMAC authenticates the
 * body. Writes nothing but OrderLead.
 */
function signatureMatches(raw: string, header: string | null, secret: string) {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const row = await prisma.workspaceIntegration.findUnique({
    where: { hookToken: token },
    select: { workspaceId: true, cartBeaconSecretEnc: true },
  });
  if (!row) return NextResponse.json({ error: "Unknown beacon" }, { status: 404 });

  const secret = row.cartBeaconSecretEnc ? decrypt(row.cartBeaconSecretEnc) : null;
  if (!secret) return NextResponse.json({ error: "Beacon not configured" }, { status: 503 });

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

  const lead = await upsertAbandonedCart(row.workspaceId, snap);
  await refreshAbandonedCartAlerts(row.workspaceId);
  return NextResponse.json({ ok: true, stored: Boolean(lead) });
}
