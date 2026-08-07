import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createPurchase } from "@/server/actions/purchases";
import { createCustomer } from "@/server/actions/customers";
import { createOrder } from "@/server/actions/orders";
import { createInternalPurchase } from "@/server/actions/internal-purchases";
import { createPartnerTxn } from "@/server/actions/partners";
import { createTreasuryEntry } from "@/server/actions/treasury";
import { createStockAdjustment } from "@/server/actions/stock-adjustments";
import { addDailySpend } from "@/server/actions/boosting";

// Dispatcher for the offline write queue. Each handler is an existing server
// action; RBAC + validation run inside them (the request carries the session).
type Handler = (slug: string, fd: FormData) => Promise<{ ok: boolean; error?: string }>;

const HANDLERS: Record<string, Handler> = {
  "purchase.create": createPurchase,
  "customer.create": createCustomer,
  "order.create": createOrder,
  "internalPurchase.create": createInternalPurchase,
  "partnerTxn.create": createPartnerTxn,
  "treasury.create": createTreasuryEntry,
  "stockAdjustment.create": createStockAdjustment,
  // Daily boost spend targets an ad set; the id rides along in the payload.
  "boostSpend.create": (slug, fd) => addDailySpend(slug, String(fd.get("adSetId") ?? ""), fd),
};

/** Postgres unique-violation, as Prisma reports it. */
function isDuplicate(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

export async function POST(req: NextRequest) {
  let body: {
    actionType?: string;
    slug?: string;
    requestId?: string;
    payload?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const { actionType, slug, requestId, payload } = body;
  if (!actionType || !slug) {
    return NextResponse.json({ ok: false, error: "Missing actionType/slug" }, { status: 400 });
  }
  const handler = HANDLERS[actionType];
  if (!handler) {
    return NextResponse.json({ ok: false, error: `Unknown action ${actionType}` }, { status: 400 });
  }

  // Claim the request id before doing any work. The outbox retries anything it
  // got no answer for, and that includes writes that committed and lost only
  // their response on the way back — replaying one of those used to buy the
  // same stock twice and take the money out of the treasury twice. Inserting
  // first means the unique key settles it, rather than a read-then-check two
  // requests could both pass.
  if (requestId) {
    try {
      await prisma.processedMutation.create({ data: { requestId, actionType } });
    } catch (e) {
      if (!isDuplicate(e)) throw e;
      const seen = await prisma.processedMutation.findUnique({ where: { requestId } });
      // Already finished: hand back the answer it got the first time, so the
      // outbox clears the item instead of trying forever.
      if (seen?.ok != null) {
        return NextResponse.json({ ok: seen.ok, error: seen.error ?? undefined });
      }
      // Claimed but not finished — either genuinely in flight, or the server
      // died mid-handler. Refusing is the safe half of that: a change that did
      // go through must never be applied twice, and one that didn't can be
      // entered again by hand. Said plainly rather than swallowed.
      return NextResponse.json({
        ok: false,
        error: "This change was already submitted. Check whether it saved before entering it again.",
      });
    }
  }

  const fd = new FormData();
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (v === null || v === undefined) continue;
    fd.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  const result = await handler(slug, fd);

  if (requestId) {
    // Recorded so a later replay gets this same answer back rather than
    // re-running the write.
    await prisma.processedMutation.update({
      where: { requestId },
      data: { ok: result.ok, error: result.error ?? null },
    });
  }
  return NextResponse.json(result);
}
