import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot-reloads in dev to avoid exhausting
// Neon connections. In production a fresh client per lambda is fine.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function withPoolDefaults(url: string | undefined) {
  if (!url) return url;
  const parsed = new URL(url);

  // Neon's pooled (-pooler) endpoint runs pgbouncer in transaction mode and
  // comfortably handles far more than 5 concurrent logical connections. A
  // limit of 5 was too tight for pages that fan out several queries at once
  // (e.g. /sales/orders: 4 top-level + variantStockMap's own 4 internal
  // parallel queries = ~8 concurrent) — the overflow queued and occasionally
  // hit the pool timeout. 10 gives real headroom without over-provisioning.
  if (!parsed.searchParams.has("connection_limit")) {
    parsed.searchParams.set("connection_limit", process.env.PRISMA_CONNECTION_LIMIT ?? "10");
  }
  if (!parsed.searchParams.has("pool_timeout")) {
    parsed.searchParams.set("pool_timeout", process.env.PRISMA_POOL_TIMEOUT ?? "30");
  }

  return parsed.toString();
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: withPoolDefaults(process.env.DATABASE_URL),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
