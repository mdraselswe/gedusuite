"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAccess, type WorkspaceAccess } from "@/lib/authz";
import { computeOrderTotals } from "@/lib/orders";
import { cashEntryNote, cashEntrySource, depositAmount } from "@/lib/order-cash";
import { newActivityGroup, recordActivity } from "@/lib/activity";
import type { ActionFailure } from "@/lib/form";

export type ActionResult = { ok: true } | ActionFailure;

/** Everything banking one order's cash needs to know about it. */
const DEPOSIT_INCLUDE = {
  items: { include: { returns: true } },
  customer: { select: { name: true } },
  heldBy: { include: { user: { select: { name: true, email: true } } } },
} as const;

type DepositableOrder = Awaited<
  ReturnType<typeof prisma.order.findFirstOrThrow<{ include: typeof DEPOSIT_INCLUDE }>>
>;

/**
 * Bank one order's cash: flag the order, write the linked treasury entry, log
 * both as a single event. Returns what reached the treasury, or why nothing
 * did.
 *
 * The whole of it, so that marking twenty orders at once and marking one does
 * exactly the same thing to each — a bulk action that grew its own slightly
 * different copy of this would be the kind of difference nobody notices until
 * the balances disagree.
 */
async function bankOrderCash(
  access: WorkspaceAccess,
  order: DepositableOrder,
): Promise<{ ok: true; amount: number } | { ok: false; error: string }> {
  // A cancelled order's payment status describes a sale that never settled, so
  // it says nothing about whether money changed hands. What was collected on
  // the doorstep does, and that is the field the cancellation dialog asks for.
  if (order.status === "CANCELLED") {
    if (Number(order.cancelledCollected) <= 0) {
      return {
        ok: false,
        error:
          "Nothing was collected on this cancellation. Record what the customer paid anyway in the cancellation costs first.",
      };
    }
  } else if (order.paymentStatus === "UNPAID") {
    // PARTIAL counts: an advance is real money somebody is holding, and
    // refusing to let it into the treasury until the order settled meant it sat
    // outside the accounts entirely, sometimes for weeks.
    return { ok: false, error: "Nothing has been collected on this order yet" };
  }
  if (order.cashInTreasury) {
    return { ok: false, error: "Already marked as deposited" };
  }

  const totals = computeOrderTotals(order);
  // What the business receives, not what the customer paid: on a COD order the
  // courier keeps its delivery charge and percentage fee before remitting, and
  // crediting the treasury with the difference was money it never held.
  const deposit = depositAmount(order, totals);
  const amount = deposit.net;
  if (amount <= 0) {
    return {
      ok: false,
      error:
        deposit.gross <= 0
          ? "No amount has been recorded as collected on this order yet."
          : "The courier's charges cover everything it collected on this order, so nothing reaches the treasury.",
    };
  }
  const source = cashEntrySource(order.paymentMethod);
  const note = cashEntryNote(order, totals.returnedUnits, deposit.courierCharges);

  const [, entry] = await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { cashInTreasury: true } }),
    prisma.treasuryEntry.create({
      data: {
        workspaceId: access.workspaceId,
        type: "IN",
        amount,
        source,
        note,
        orderId: order.id,
        date: new Date(),
      },
    }),
  ]);

  // Two rows, one decision: the order stops waiting for its money and the
  // treasury gains it. Shared groupId so the history shows that as one event
  // rather than two lines a second apart that nobody can connect.
  const group = newActivityGroup();
  const label = `#${order.id.slice(-8).toUpperCase()} · ${order.customer?.name ?? "Walk-in"}`;
  await recordActivity(access, [
    {
      action: "UPDATE",
      entity: "Order",
      entityId: order.id,
      entityLabel: label,
      summary: `Cash marked as reaching the treasury — ৳${amount}`,
      changes: { cashInTreasury: { from: false, to: true } },
      groupId: group,
    },
    {
      action: "CREATE",
      entity: "TreasuryEntry",
      entityId: entry.id,
      entityLabel: source,
      summary:
        `৳${amount} in — ${note}` +
        (deposit.courierCharges > 0
          ? ` (customer paid ৳${deposit.gross}, courier kept ৳${deposit.courierCharges})`
          : ""),
      groupId: group,
    },
  ]);

  return { ok: true, amount };
}

/** Every page whose numbers move when an order's cash lands in the treasury. */
function revalidateCashPaths(slug: string): void {
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
}

/**
 * Confirm a PAID order's cash has physically reached the shared treasury —
 * a deliberate, human-confirmed action (not automatic on payment status
 * change, since a COD/courier payment being "PAID" doesn't mean the business
 * has the cash yet; it might still be with the courier or a team member).
 * Creates a linked TreasuryEntry so the deposit is traceable and reversible.
 */
export async function markCashDeposited(
  slug: string,
  orderId: string,
): Promise<ActionResult> {
  // Confirming money reached the treasury is OWNER-level, matching treasury "full".
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId: gate.access.workspaceId },
    include: DEPOSIT_INCLUDE,
  });
  if (!order) return { ok: false, error: "Order not found" };

  const res = await bankOrderCash(gate.access, order);
  if (!res.ok) return res;

  revalidateCashPaths(slug);
  return { ok: true };
}

export type BulkDepositResult =
  | { ok: true; banked: number; total: number; skipped: { label: string; error: string }[] }
  | ActionFailure;

/**
 * Bank a whole courier remittance in one go.
 *
 * A courier pays out its collections as one transfer covering fifteen parcels,
 * and confirming that fifteen times over — each a click, a round trip and a
 * page refresh — is how rows get missed and the treasury drifts below what the
 * shop has actually taken.
 *
 * Ineligible rows are skipped and named rather than failing the batch: the
 * caller's list is a snapshot of a page that may be minutes old, and one order
 * settled from another tab in the meantime must not stop the other fourteen.
 * Each is banked on its own so a failure late in the list leaves the ones
 * before it banked — the same as having clicked them individually.
 */
export async function markAllCashDeposited(
  slug: string,
  orderIds: string[],
): Promise<BulkDepositResult> {
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;
  if (orderIds.length === 0) return { ok: true, banked: 0, total: 0, skipped: [] };

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds }, workspaceId: gate.access.workspaceId },
    include: DEPOSIT_INCLUDE,
    orderBy: { date: "asc" },
  });

  let banked = 0;
  let total = 0;
  const skipped: { label: string; error: string }[] = [];
  for (const order of orders) {
    const res = await bankOrderCash(gate.access, order);
    if (res.ok) {
      banked += 1;
      total += res.amount;
    } else {
      skipped.push({
        label: `#${order.id.slice(-8).toUpperCase()} · ${order.customer?.name ?? "Walk-in"}`,
        error: res.error,
      });
    }
  }

  if (banked > 0) revalidateCashPaths(slug);
  return {
    ok: true,
    banked,
    total: Math.round((total + Number.EPSILON) * 100) / 100,
    skipped,
  };
}

/** Undo a mark-deposited: removes the linked treasury entry and resets the flag. */
export async function unmarkCashDeposited(
  slug: string,
  orderId: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    select: {
      id: true,
      cashInTreasury: true,
      customer: { select: { name: true } },
      treasuryEntry: { select: { id: true, amount: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };
  if (!order.cashInTreasury) return { ok: true };

  const removed = order.treasuryEntry ? Number(order.treasuryEntry.amount) : 0;
  await prisma.$transaction([
    prisma.treasuryEntry.deleteMany({ where: { workspaceId, orderId } }),
    prisma.order.update({ where: { id: orderId }, data: { cashInTreasury: false } }),
  ]);

  // Money leaving the treasury balance is the single most alarming thing to
  // find unexplained, so this line says how much and against which order.
  const group = newActivityGroup();
  const label = `#${orderId.slice(-8).toUpperCase()} · ${order.customer?.name ?? "Walk-in"}`;
  await recordActivity(gate.access, [
    {
      action: "UPDATE",
      entity: "Order",
      entityId: orderId,
      entityLabel: label,
      summary: `Deposit undone — ৳${removed} taken back out of the treasury`,
      changes: { cashInTreasury: { from: true, to: false } },
      groupId: group,
    },
    ...(order.treasuryEntry
      ? [
          {
            action: "DELETE" as const,
            entity: "TreasuryEntry",
            entityId: order.treasuryEntry.id,
            entityLabel: label,
            summary: `৳${removed} entry removed — the order's deposit was undone`,
            groupId: group,
          },
        ]
      : []),
  ]);

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
