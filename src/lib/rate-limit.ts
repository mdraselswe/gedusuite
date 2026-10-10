import { prisma } from "@/lib/prisma";

export type RateLimitResult = {
  allowed: boolean;
  /** How many tries this window has used, including this one. */
  count: number;
  /** Seconds until the window resets. */
  retryAfterSec: number;
};

/**
 * Fixed-window counter in the database.
 *
 * One atomic upsert, so two simultaneous requests cannot both read "9 of 10"
 * and both pass. Fails OPEN: if the database hiccups the person gets in rather
 * than being locked out of their own business — the throttle exists to slow
 * guessing, not to be a point of failure.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  try {
    const rows = await prisma.$queryRaw<{ count: number; secs: number }[]>`
      INSERT INTO "RateLimit" ("key", "count", "resetAt")
      VALUES (${key}, 1, NOW() + (${windowSec} * INTERVAL '1 second'))
      ON CONFLICT ("key") DO UPDATE SET
        "count"   = CASE WHEN "RateLimit"."resetAt" <= NOW() THEN 1 ELSE "RateLimit"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimit"."resetAt" <= NOW()
                         THEN NOW() + (${windowSec} * INTERVAL '1 second')
                         ELSE "RateLimit"."resetAt" END
      RETURNING "count",
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM ("RateLimit"."resetAt" - NOW()))))::int AS "secs"`;
    const r = rows[0];
    return { allowed: r.count <= limit, count: r.count, retryAfterSec: r.secs };
  } catch {
    return { allowed: true, count: 0, retryAfterSec: 0 };
  }
}

/** Forget a key — used after a successful sign-in so honest typos don't pile up. */
export async function resetRateLimit(key: string): Promise<void> {
  try {
    await prisma.rateLimit.deleteMany({ where: { key } });
  } catch {
    /* best effort */
  }
}

/** Housekeeping, called from the nightly cron. */
export async function purgeExpiredRateLimits(): Promise<number> {
  const r = await prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date() } } });
  return r.count;
}

type HeaderBag =
  | { get(name: string): string | null | undefined }
  | Record<string, string | string[] | undefined>;

/** First hop of x-forwarded-for, which on Vercel is the real client. */
export function clientIp(headers: HeaderBag | undefined): string {
  if (!headers) return "unknown";
  const read = (n: string): string | undefined => {
    if (typeof (headers as { get?: unknown }).get === "function") {
      return (headers as { get(n: string): string | null | undefined }).get(n) ?? undefined;
    }
    const v = (headers as Record<string, string | string[] | undefined>)[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const xff = read("x-forwarded-for");
  return (xff?.split(",")[0]?.trim() || read("x-real-ip") || "unknown").slice(0, 64);
}
