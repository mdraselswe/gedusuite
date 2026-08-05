import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

// Neon's serverless driver speaks Postgres over a WebSocket to Neon's proxy
// instead of holding a raw TCP socket open. Neon drops idle connections
// aggressively, and the plain client didn't cope: "Error in PostgreSQL
// connection: kind: Closed" would put the whole pool into a state it never
// recovered from without a restart, and every query after that failed with
// "Timed out fetching a new connection from the connection pool". This driver
// reconnects underneath instead. It matters most for /api/cron/woo-lead —
// WooCommerce disables a webhook after five consecutive failed deliveries, so
// a dead pool would silently stop orders arriving.
//
// `ws` is set unconditionally rather than only when globalThis.WebSocket is
// missing: Node 22+ ships a WHATWG WebSocket, but Neon's driver wants the ws
// package's nodebuffer binary type, and "works on my Node version" is not
// something to leave to chance across local, CI and Vercel.
neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;

// Reuse a single PrismaClient across hot-reloads in dev to avoid exhausting
// Neon connections. In production a fresh client per lambda is fine.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// `connection_limit` and `pool_timeout` are Prisma-engine query params. Pooling
// belongs to the driver now, so strip them rather than hand the driver params
// it doesn't understand; pool size comes from PoolConfig.max below.
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
    // Neon hangs up idle connections at its own pace — and suspends the
    // compute entirely after a quiet spell — so a socket kept past that point
    // fails on the NEXT query: "Connection terminated unexpectedly", landing
    // on whatever the user happened to click. Retiring idle connections first
    // means a query never inherits a dead one.
    idleTimeoutMillis: 60_000,
    // Generous on purpose. Waking a suspended Neon compute takes seconds
    // (measured ~3.7s cold against ~0.3s warm), and a page that fans out
    // several queries opens several handshakes at once — a tight limit here
    // turns a slow wake-up into "timeout exceeded when trying to connect",
    // which is a worse failure than waiting.
    connectionTimeoutMillis: 30_000,
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
