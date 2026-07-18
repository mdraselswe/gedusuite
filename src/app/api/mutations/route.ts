import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createPurchase } from "@/server/actions/purchases";
import { createCustomer } from "@/server/actions/customers";
import { createOrder } from "@/server/actions/orders";
import { createInternalPurchase } from "@/server/actions/internal-purchases";
import { createPartnerTxn } from "@/server/actions/partners";
import { createTreasuryEntry } from "@/server/actions/treasury";
import { createStockAdjustment } from "@/server/actions/stock-adjustments";

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
};

export async function POST(req: NextRequest) {
  let body: { actionType?: string; slug?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const { actionType, slug, payload } = body;
  if (!actionType || !slug) {
    return NextResponse.json({ ok: false, error: "Missing actionType/slug" }, { status: 400 });
  }
  const handler = HANDLERS[actionType];
  if (!handler) {
    return NextResponse.json({ ok: false, error: `Unknown action ${actionType}` }, { status: 400 });
  }

  const fd = new FormData();
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (v === null || v === undefined) continue;
    fd.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }

  const result = await handler(slug, fd);
  return NextResponse.json(result);
}
