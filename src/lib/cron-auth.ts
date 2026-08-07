import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * The gate on the scheduled endpoints.
 *
 * These live under /api/cron, which the proxy treats as public — Vercel Cron
 * carries no session cookie, so there is nothing else for it to authenticate
 * with. The shared secret is therefore the ONLY thing standing in front of
 * them, and the previous check was `if (secret) { ...verify... }`: with the
 * variable unset it verified nothing and let everyone through. Unset is
 * exactly the state a deployment is in when nobody remembered to set it —
 * which was likely here, because the README asked for BACKUP_CRON_SECRET and
 * the code read CRON_SECRET.
 *
 * So it fails closed. No secret configured means nobody gets in, including
 * Vercel, and a backup that stops running is a great deal louder than one
 * anybody on the internet can trigger in a loop.
 *
 * Returns a response to send back, or null when the request may proceed.
 */
export function denyCron(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "CRON_SECRET is not configured on this deployment, so scheduled endpoints are disabled.",
      },
      { status: 503 },
    );
  }

  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  // Constant-time: a plain !== leaks the secret one character at a time to
  // anyone willing to measure. Lengths are compared first because
  // timingSafeEqual throws on a mismatch.
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
