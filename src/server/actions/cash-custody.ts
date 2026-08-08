"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { computeOrderTotals } from "@/lib/orders";
import { cashEntryNote, cashEntrySource, depositAmount } from "@/lib/order-cash";
import type { ActionFailure } from "@/lib/form";

export type ActionResult = { ok: true } | ActionFailure;

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
  const workspaceId = gate.access.workspaceId;

  const order = await prisma.order.findFirst({
    where: { id: orderId, workspaceId },
    include: {
      items: { include: { returns: true } },
      customer: { select: { name: true } },
      heldBy: { include: { user: { select: { name: true, email: true } } } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };
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

  await prisma.$transaction([
    prisma.order.update({ where: { id: orderId }, data: { cashInTreasury: true } }),
    prisma.treasuryEntry.create({
      data: {
        workspaceId,
        type: "IN",
        amount,
        source,
        note,
        orderId,
        date: new Date(),
      },
    }),
  ]);

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
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
    select: { id: true, cashInTreasury: true },
  });
  if (!order) return { ok: false, error: "Order not found" };
  if (!order.cashInTreasury) return { ok: true };

  await prisma.$transaction([
    prisma.treasuryEntry.deleteMany({ where: { workspaceId, orderId } }),
    prisma.order.update({ where: { id: orderId }, data: { cashInTreasury: false } }),
  ]);

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/sales/orders`);
  revalidatePath(`/${slug}/couriers`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
