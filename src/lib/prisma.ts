import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

// Neon's serverless driver speaks Postgres over a WebSocket to Neon's proxy
// instead of opening a fresh TCP + TLS + SCRAM handshake from every cold
// lambda. Node 22+ ships a global WebSocket; `next dev` on older Node (and
// some CI runtimes) doesn't, hence the `ws` fallback.
if (!globalThis.WebSocket) {
  neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
}

// Reuse a single PrismaClient across hot-reloads in dev to avoid exhausting
// Neon connections. In production a fresh client per lambda is fine.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// `connection_limit` / `pool_timeout` are Prisma-engine query params. The Neon
// driver owns pooling now, so strip them rather than hand the driver params it
// doesn't understand; pool size comes from PoolConfig.max below.
function driverUrl(url: string | undefined) {
  if (!url) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete("connection_limit");
  parsed.searchParams.delete("pool_timeout");
  return parsed.toString();
}

function makeClient() {
  // Neon's pooled (-pooler) endpoint runs pgbouncer in transaction mode and
  // comfortably handles far more than 5 concurrent logical connections. A
  // limit of 5 was too tight for pages that fan out several queries at once
  // (e.g. /sales/orders: 4 top-level + variantStockMap's own 4 internal
  // parallel queries = ~8 concurrent) — the overflow queued and occasionally
  // hit the pool timeout. 10 gives real headroom without over-provisioning.
  const adapter = new PrismaNeon({
    connectionString: driverUrl(process.env.DATABASE_URL),
    max: Number(process.env.PRISMA_CONNECTION_LIMIT ?? 10),
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
