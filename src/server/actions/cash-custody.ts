"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { computeOrderTotals } from "@/lib/orders";

export type ActionResult = { ok: true } | { ok: false; error: string };

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
  if (order.paymentStatus !== "PAID") {
    return { ok: false, error: "Order isn't marked PAID yet" };
  }
  if (order.cashInTreasury) {
    return { ok: false, error: "Already marked as deposited" };
  }

  const amount = computeOrderTotals(order).customerTotal;
  const holderName = order.heldBy ? (order.heldBy.user.name ?? order.heldBy.user.email) : null;
  const source = order.paymentMethod === "COURIER_COLLECTION" ? "Courier remittance" : "Sales collection";
  const note = [
    order.customer?.name ? `Order for ${order.customer.name}` : "Walk-in order",
    holderName ? `collected by ${holderName}` : null,
  ]
    .filter(Boolean)
    .join(", ");

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
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
