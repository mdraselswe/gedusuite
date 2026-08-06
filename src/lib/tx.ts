import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Transactions for the two things that are decided by reading a total and then
 * writing against it: spending from the treasury, and selling from stock.
 *
 * Moving those reads inside the transaction is necessary but not sufficient.
 * Postgres defaults to READ COMMITTED, where a SUM takes no lock at all, so two
 * transactions can each read a balance of 10,000, each spend 8,000, and each
 * commit happily — the treasury ends at −6,000 having passed both checks.
 * Stock is worse, because it is derived rather than stored: there is no column
 * for a constraint to defend, so nothing anywhere stops the same last piece
 * being sold twice.
 *
 * SERIALIZABLE is what actually decides it. Postgres tracks what each
 * transaction read, notices the two outcomes couldn't both have happened in
 * some serial order, and aborts one with a serialization failure — which
 * Prisma surfaces as P2034. That abort is expected rather than exceptional, so
 * it's retried a couple of times before anyone is told about it; a conflict is
 * only worth a message once retrying has stopped helping.
 */

const MAX_ATTEMPTS = 3;

/** A write that lost a race often enough that retrying stopped being useful. */
export class ConcurrentWrite extends Error {
  constructor() {
    super("Someone else saved a change to the same figures at that moment. Please try again.");
    this.name = "ConcurrentWrite";
  }
}

/** Postgres serialization failure / deadlock, as Prisma reports it. */
function isSerializationFailure(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2034" || e.meta?.code === "40001")
  );
}

/**
 * Run `fn` in a SERIALIZABLE transaction, retrying a lost race a few times.
 * Throws ConcurrentWrite when it keeps losing; every other error passes
 * through untouched.
 */
export async function runSerializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        // Generous: a cold Neon compute can take seconds to wake, and a
        // timeout here would read to the user as a failed save.
        timeout: options.timeout ?? 15_000,
      });
    } catch (e) {
      if (!isSerializationFailure(e)) throw e;
      if (attempt >= MAX_ATTEMPTS) throw new ConcurrentWrite();
      // Brief, growing pause so the retry doesn't collide with the same writer.
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }
}
