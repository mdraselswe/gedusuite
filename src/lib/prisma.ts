import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot-reloads in dev to avoid exhausting
// Neon connections. In production a fresh client per lambda is fine.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function withPoolDefaults(url: string | undefined) {
  if (!url) return url;
  const parsed = new URL(url);

  // Neon pooled connections are still easy to exhaust when a single page
  // renders several server components/actions at once. Keep each app process
  // modest and wait a little longer instead of failing after the default 10s.
  if (!parsed.searchParams.has("connection_limit")) {
    parsed.searchParams.set("connection_limit", process.env.PRISMA_CONNECTION_LIMIT ?? "5");
  }
  if (!parsed.searchParams.has("pool_timeout")) {
    parsed.searchParams.set("pool_timeout", process.env.PRISMA_POOL_TIMEOUT ?? "20");
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
