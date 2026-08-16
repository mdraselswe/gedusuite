"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAccess, type WorkspaceAccess } from "@/lib/authz";
import { computeOrderTotals } from "@/lib/orders";
import {
  bankedSoFar,
  cashEntryNote,
  cashEntrySource,
  codBaseFor,
  collectionRecorded,
  courierChargeNote,
  deliveryCostCharged,
  depositAmount,
  stillToBank,
} from "@/lib/order-cash";
import { newActivityGroup, recordActivity } from "@/lib/activity";
import { loadCourierCredentials } from "@/lib/courier-credentials";
import { getPayment, listPayments } from "@/lib/steadfast";
import type { ActionFailure } from "@/lib/form";
import { round2 } from "@/lib/money";

export type ActionResult = { ok: true } | ActionFailure;

/** Everything banking one order's cash needs to know about it. */
const DEPOSIT_INCLUDE = {
  items: { include: { returns: true } },
  customer: { select: { name: true } },
  heldBy: { include: { user: { select: { name: true, email: true } } } },
  // What the treasury already holds against this order — an order banked while
  // it was part-paid can take another instalment afterwards, and only the
  // difference is still waiting to be handed over.
  treasuryEntry: { select: { id: true, type: true, amount: true } },
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
  const totals = computeOrderTotals(order);
  // What the business receives, not what the customer paid: on a COD order the
  // courier keeps its delivery charge and percentage fee before remitting, and
  // crediting the treasury with the difference was money it never held. The
  // figure is signed — a parcel that collected nothing still owes the courier
  // for the trip, and that is an outflow, not a deposit of zero.
  const deposit = depositAmount(order, totals);
  // Signed, so a courier's charge counts the way it moves the balance.
  const alreadyBanked = bankedSoFar(order.treasuryEntry);
  // What is being handed over now: the whole of it on a first deposit, and only
  // the difference on an order that was banked while it was part-paid and has
  // taken another instalment since. The entry used to grow itself the moment
  // that instalment was recorded, which put money in the treasury that was
  // still in somebody's pocket.
  const amount = stillToBank(deposit.net, alreadyBanked);
  const total = deposit.net;
  if (order.cashInTreasury && amount === 0) {
    return { ok: false, error: "Already marked as deposited" };
  }
  // PARTIAL counts as collected: an advance is real money somebody is holding,
  // and refusing to let it into the treasury until the order settled meant it
  // sat outside the accounts entirely, sometimes for weeks. A PARTIAL with no
  // figure on it is the opposite case — it only READS as zero collected, so a
  // courier charge must not be turned into an outflow on the strength of it.
  if (!collectionRecorded(order)) {
    return { ok: false, error: "Nothing has been collected on this order yet" };
  }
  if (amount === 0) {
    return {
      ok: false,
      error:
        // A cancelled order's payment status describes a sale that never
        // settled, so it says nothing about whether money changed hands. What
        // was collected on the doorstep does — and so does what the courier
        // charged to bring the parcel back; either one is a movement worth
        // recording, and this order has neither.
        order.status === "CANCELLED"
          ? "This cancellation has no money on it — nothing collected from the customer, and no courier charge recorded. Fill those in on the cancellation costs first."
          : deposit.gross <= 0
            ? "No amount has been recorded as collected on this order yet."
            : "The courier's charges cover exactly what it collected on this order, so nothing moves either way.",
    };
  }

  // Below zero the movement is the courier's bill, not a deposit: it collected
  // nothing (a giveaway, an order already paid another way) or less than the
  // trip cost, and takes the difference out of the shop's balance. The entry
  // carries the running total, not this instalment — one entry per order is all
  // the schema allows, and the total is what the treasury is holding.
  const outward = total < 0;
  const source = cashEntrySource(order.paymentMethod, outward ? "OUT" : "IN");
  const note = outward
    ? courierChargeNote(order, deposit.gross)
    : cashEntryNote(order, totals.returnedUnits, deposit.courierCharges);
  const entryData = {
    type: (outward ? "OUT" : "IN") as "IN" | "OUT",
    // The direction is the sign; the column holds a magnitude, the same as
    // every other entry in the ledger.
    amount: Math.abs(total),
    source,
    note,
  };

  const [, entry] = await prisma.$transaction([
    prisma.order.update({ where: { id: order.id }, data: { cashInTreasury: true } }),
    order.treasuryEntry
      ? prisma.treasuryEntry.update({
          where: { id: order.treasuryEntry.id },
          data: entryData,
        })
      : prisma.treasuryEntry.create({
          data: {
            workspaceId: access.workspaceId,
            ...entryData,
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
      summary: outward
        ? `Courier charges settled — ৳${Math.abs(amount)} out of the treasury`
        : `Cash marked as reaching the treasury — ৳${amount}` +
          // Which instalment this was, when it isn't the whole of it.
          (alreadyBanked !== 0 ? ` (৳${alreadyBanked} was already in, now ৳${total})` : ""),
      changes: { cashInTreasury: { from: order.cashInTreasury, to: true } },
      groupId: group,
    },
    {
      action: order.treasuryEntry ? "UPDATE" : "CREATE",
      entity: "TreasuryEntry",
      entityId: entry.id,
      entityLabel: source,
      summary: outward
        ? `৳${Math.abs(total)} out — ${note}`
        : `৳${total} in — ${note}` +
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
    total: round2(total),
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
      treasuryEntry: { select: { id: true, amount: true, type: true } },
    },
  });
  if (!order) return { ok: false, error: "Order not found" };
  if (!order.cashInTreasury) return { ok: true };

  const removed = order.treasuryEntry ? Number(order.treasuryEntry.amount) : 0;
  // Undoing a courier charge puts money back rather than taking it away, and a
  // history line that says the opposite of what the balance did is worse than
  // no line at all.
  const wasOutflow = order.treasuryEntry?.type === "OUT";
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
      summary: wasOutflow
        ? `Courier charge undone — ৳${removed} put back into the treasury`
        : `Deposit undone — ৳${removed} taken back out of the treasury`,
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
            summary: `৳${removed} entry removed — the order's ${
              wasOutflow ? "courier charge" : "deposit"
            } was undone`,
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


export type PayoutImportResult =
  | {
      ok: true;
      imported: number;
      alreadyKnown: number;
      /** Consignments the courier paid for that no order here matches. */
      unmatched: string[];
      /**
       * Parcels the courier settled for something other than this app expected.
       * Reported, never applied: recording one moves an order's profit and its
       * cash, and the payout is not the place to do that to a dozen orders at
       * once. The COD cell on the balance page is.
       */
      collectionGaps: {
        trackingId: string;
        customerName: string;
        expected: number;
        collected: number;
        /** collected − expected. Negative means less arrived than was billed. */
        gap: number;
      }[];
      payouts: {
        externalId: string;
        total: number;
        parcels: number;
        difference: number;
        /** What this app's rates make the payout's delivery bills come to. */
        deliveryBilled: number;
        /** What the courier actually billed for them. */
        dueBills: number;
        /** deliveryBilled − dueBills. Non-zero means a zone or weight is wrong. */
        deliveryGap: number;
      }[];
    }
  | ActionFailure;


/**
 * Bring in what the courier has actually paid out.
 *
 * The app can work out what a courier OUGHT to be holding; it can never work
 * out what a payout actually paid, or which parcels were in it. Both are facts
 * the courier keeps, and both are what "mark remitted" was guessing at — close
 * enough that the treasury looked right, and wrong enough that it drifted from
 * the bank by a fraction of a taka every time.
 *
 * So the payout leads. Each parcel it names is banked the ordinary way, so the
 * per-order attribution is exactly what clicking each row would have produced.
 * Then one entry carries the difference between what those orders came to and
 * what the courier actually sent — which is the percentage fee, charged on the
 * payout as a whole and floored to a whole taka, plus anything else the two
 * sides see differently. The treasury ends up holding the transfer that
 * reached the bank, to the paisa, and the difference is a line somebody can
 * read rather than a slow leak.
 *
 * Importing twice is a no-op: the courier's own payment id is unique per
 * courier, and a payout already recorded is skipped.
 */
export async function importCourierPayouts(
  slug: string,
  courierId: string,
): Promise<PayoutImportResult> {
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const courier = await prisma.courier.findFirst({
    where: { id: courierId, workspaceId },
    select: { id: true, name: true, apiKeyEnc: true },
  });
  if (!courier) return { ok: false, error: "Courier not found" };
  if (!courier.apiKeyEnc) {
    return { ok: false, error: `${courier.name} has no API key — add one in Settings → Couriers` };
  }
  const creds = await loadCourierCredentials(courier.id);
  if (!creds) {
    return { ok: false, error: `Could not read ${courier.name}'s API credentials — enter them again` };
  }

  const list = await listPayments(creds);
  if (!list.ok) return { ok: false, error: list.error };

  const known = await prisma.courierPayout.findMany({
    where: { courierId: courier.id },
    select: { externalId: true },
  });
  const seen = new Set(known.map((k) => k.externalId));

  // Oldest first, so the parcels of an early payout are banked before a later
  // one is looked at — otherwise a parcel in two lists would land in the wrong
  // one, and the difference would move with it.
  const pending = list.data
    .filter((p) => !seen.has(p.payment_id))
    .sort((a, b) => (a.paid_at ?? a.created_at ?? "").localeCompare(b.paid_at ?? b.created_at ?? ""));

  const unmatched: string[] = [];
  /** Parcels the courier settled for something other than this app expected. */
  const collectionGaps: {
    trackingId: string;
    customerName: string;
    /** What this app thought the courier collected. */
    expected: number;
    /** What the payout says it collected. */
    collected: number;
    /** collected − expected. Negative means the shop got less than it billed. */
    gap: number;
  }[] = [];
  const imported: {
    externalId: string;
    total: number;
    parcels: number;
    difference: number;
    /** Sum of this app's delivery costs for the payout's parcels. */
    deliveryBilled: number;
    /** What the courier actually billed for delivery across them. */
    dueBills: number;
    /** deliveryBilled − dueBills. Non-zero means a rate rule is wrong. */
    deliveryGap: number;
  }[] = [];

  for (const summary of pending) {
    const detail = await getPayment(creds, summary.payment_id);
    if (!detail.ok) return { ok: false, error: detail.error };

    const consignmentIds = detail.data.consignments.map((c) => String(c.consignment_id));
    const orders = await prisma.order.findMany({
      where: { workspaceId, courierTrackingId: { in: consignmentIds } },
      include: DEPOSIT_INCLUDE,
      orderBy: { date: "asc" },
    });
    const found = new Set(orders.map((o) => o.courierTrackingId));
    for (const id of consignmentIds) if (!found.has(id)) unmatched.push(id);

    /**
     * What the courier says it collected, parcel by parcel, against what this
     * app thinks it collected.
     *
     * The payout is the only place Steadfast reports a per-parcel figure, and
     * it reports the one that matters: what came back off the doorstep, not
     * what was booked. A parcel booked at 960 that a rider settled for 940
     * shows 940 here — which is how a twenty-taka gap between this app and
     * Steadfast's balance went unexplained until somebody read it off a phone
     * screen, one parcel at a time.
     *
     * Reported, not written. Recording a shortfall moves an order's profit and
     * what its cash comes to, and doing that to a dozen orders at once inside
     * an import — on the strength of a field whose meaning is inferred rather
     * than documented — is not a thing to do quietly. The person is pointed at
     * the row instead, and the COD cell on this page is already the place to
     * answer it.
     *
     * Cancelled parcels are skipped: a partial delivery keeps its collected
     * figure in `cancelledCollected`, typed with the cancellation, and reading
     * this as a shortfall on top of it would count the same gap twice.
     */
    const byTracking = new Map(orders.map((o) => [o.courierTrackingId, o]));
    for (const c of detail.data.consignments) {
      const order = byTracking.get(String(c.consignment_id));
      if (!order || order.status === "CANCELLED") continue;
      const totals = computeOrderTotals(order);
      const expected = codBaseFor(order, totals);
      const gap = round2(Number(c.cod_amount) - expected);
      if (Math.abs(gap) < 0.01) continue;
      collectionGaps.push({
        trackingId: String(c.consignment_id),
        customerName: order.customer?.name ?? "Walk-in",
        expected,
        collected: round2(Number(c.cod_amount)),
        gap,
      });
    }

    // Bank the ones that aren't banked yet, exactly as clicking each row would.
    for (const order of orders) {
      if (order.cashInTreasury) continue;
      await bankOrderCash(gate.access, order);
    }

    // What the treasury actually holds against this payout — read back, so an
    // order that could not be banked is left out of the sum rather than
    // assumed into it. Whatever it doesn't cover ends up in the difference,
    // which is the line that keeps the ledger equal to the bank either way.
    const banked = await prisma.order.findMany({
      where: { id: { in: orders.map((o) => o.id) }, cashInTreasury: true },
      include: DEPOSIT_INCLUDE,
    });
    const ordersTotal = round2(
      banked.reduce((sum, o) => sum + depositAmount(o, computeOrderTotals(o)).net, 0),
    );
    const difference = round2(Number(detail.data.total) - ordersTotal);

    /**
     * What the courier billed for carrying these parcels, against what this
     * app expected it to.
     *
     * Only ever the total: Steadfast reports `due_bills` for the payout and
     * has no endpoint that gives a parcel's own charge, so this can say how
     * far out the rate table is but never which parcel put it there. Still
     * worth saying — it is the difference between "the rates are right" and
     * "twenty taka came from somewhere", and the rate table is a thing that
     * can actually be corrected.
     *
     * It was 20 out on the payout that prompted this, from two parcels: a
     * Savar one billed at the outside-Dhaka rate because the app had no
     * sub-urban zone, and an unweighed one billed at its zone's top band. Both
     * were fixable rules; both were invisible, because the gap went into the
     * difference entry below and that entry gets read as rounding.
     */
    const deliveryBilled = round2(
      orders.reduce((s, o) => s + deliveryCostCharged(o, computeOrderTotals(o)), 0),
    );
    const deliveryGap = round2(deliveryBilled - Number(detail.data.due_bills));

    const group = newActivityGroup();
    const paidAt = detail.data.paid_at
      ? new Date(detail.data.paid_at.replace(" ", "T") + "Z")
      : null;

    // The payout row and the entry that balances it, in one transaction.
    // Written one after the other, a failure in between left the payout
    // recorded — so the next import skips it as already known — with the
    // difference missing from the treasury for good. Small (it is the rounded
    // percentage fee) and permanent, and invisible, because the payout looks
    // imported.
    //
    // The per-order banking above stays outside it: that half is already
    // idempotent through the unique TreasuryEntry.orderId, and holding a
    // transaction open across it would mean holding one open across every
    // order in the payout.
    const payout = await prisma.$transaction(async (tx) => {
      const row = await tx.courierPayout.create({
        data: {
          workspaceId,
          courierId: courier.id,
          externalId: detail.data.payment_id,
          amount: detail.data.amount,
          deliveryBills: detail.data.due_bills,
          charges: detail.data.charges,
          total: detail.data.total,
          method: detail.data.method,
          paidAt,
          consignmentIds,
          ordersTotal,
        },
      });
      if (Math.abs(difference) >= 0.01) {
        const outward = difference < 0;
        await tx.treasuryEntry.create({
          data: {
            workspaceId,
            type: outward ? "OUT" : "IN",
            amount: Math.abs(difference),
            source: `${courier.name} payout difference`,
            note:
              `${courier.name} paid ৳${detail.data.total} on ${detail.data.payment_id}; ` +
              `the ${banked.length} order(s) in it come to ৳${ordersTotal}. The fee is charged ` +
              `on the payout as a whole and rounded, so the two never land on the same paisa.` +
              // Named here too, because this note is what somebody reads when
              // they ask where the difference came from — and "rounding" on
              // its own is a lie the moment a rate rule is wrong.
              (Math.abs(deliveryGap) >= 0.01
                ? ` ৳${Math.abs(deliveryGap)} of it is delivery charges: this app billed ` +
                  `৳${deliveryBilled} against the courier's ৳${detail.data.due_bills}.`
                : ""),
            date: paidAt ?? new Date(),
          },
        });
      }
      return row;
    });

    await recordActivity(gate.access, {
      action: "CREATE",
      entity: "CourierPayout",
      entityId: payout.id,
      entityLabel: `${courier.name} · ${detail.data.payment_id}`,
      summary:
        `Payout imported — ৳${detail.data.total} for ${orders.length} parcel(s)` +
        (Math.abs(difference) >= 0.01 ? `, ৳${Math.abs(difference)} difference recorded` : ""),
      groupId: group,
    });

    imported.push({
      externalId: detail.data.payment_id,
      total: Number(detail.data.total),
      parcels: orders.length,
      difference,
      deliveryBilled,
      dueBills: Number(detail.data.due_bills),
      deliveryGap,
    });
  }

  if (imported.length > 0) revalidateCashPaths(slug);
  return {
    ok: true,
    imported: imported.length,
    alreadyKnown: seen.size,
    unmatched,
    collectionGaps,
    payouts: imported,
  };
}
