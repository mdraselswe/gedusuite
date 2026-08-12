import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { WorkspaceAccess } from "@/lib/authz";
import { dhakaDayKey, dhakaStampLine } from "@/lib/dhaka-time";

/**
 * The audit trail: who changed what, and when.
 *
 * Recorded from the action layer, after the write has committed, rather than
 * from a Prisma extension that watches every query. An extension sees every
 * ATTEMPT: `runSerializable` retries a conflicted transaction, so one created
 * order would be logged twice, and a rolled-back transaction would leave an
 * entry for a change that never happened. A history that lies about the past
 * is worse than no history, so the cost of writing these calls by hand is the
 * right cost to pay.
 *
 * Failing to log must never fail the write it describes. The user's order is
 * saved; a missing line in the history is a smaller problem than an error
 * message on a screen where nothing actually went wrong.
 */

export type ActivityAction = "CREATE" | "UPDATE" | "DELETE";

/** `{ field: { from, to } }` — only the fields that actually moved. */
export type FieldChanges = Record<string, { from: unknown; to: unknown }>;

export type ActivityInput = {
  action: ActivityAction;
  /** Prisma model name: "Order", "Purchase", "TreasuryEntry". */
  entity: string;
  entityId: string;
  /** What the record is called, so a deleted row still reads as something. */
  entityLabel?: string | null;
  /** One human sentence, in the past tense: "Cancelled — ৳120 collected". */
  summary: string;
  changes?: FieldChanges | null;
  /** Shared by the rows one user action wrote. See `newActivityGroup`. */
  groupId?: string | null;
};

/** A label for a group of entries written by the same action. */
export function newActivityGroup(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Values a person can read, from values Prisma returns.
 *
 * Decimal and Date both stringify into something unreadable or misleading
 * (`{"s":1,"e":2,"d":[115]}`, a UTC ISO timestamp for a date a shopkeeper reads
 * in Dhaka), and the history is read by a shopkeeper, not a debugger.
 *
 * A date keeps its time of day. The forms record one now, so cutting the stamp
 * at the day would report "changed the date from 12 Aug to 12 Aug" when somebody
 * corrected the hour — a history entry saying nothing happened. A date-only
 * value still reads as its day, because 6 AM Dhaka is where midnight UTC lands
 * and printing that would invent a time the record never had.
 */
function plain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return v.getTime() % 86_400_000 === 0 ? dhakaDayKey(v) : dhakaStampLine(v);
  }
  if (typeof v === "object" && v !== null && "toNumber" in v) {
    return Number((v as { toNumber(): number }).toNumber());
  }
  if (typeof v === "object") return JSON.parse(JSON.stringify(v));
  return v;
}

/**
 * What changed between two snapshots of a record.
 *
 * Only the listed fields are compared, and only the ones that moved come back:
 * an edit that saved the same values is not an event, and a history full of
 * "changed nothing" entries is one nobody reads. Returns null when nothing
 * moved, which is the signal not to write an entry at all.
 */
export function diffFields(
  // Deliberately loose: the "before" snapshot is usually a wider select than
  // the read-back "after", and forcing one type on both would mean fetching
  // columns nothing needs just to satisfy the compiler.
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): FieldChanges | null {
  const changes: FieldChanges = {};
  for (const field of fields) {
    const from = plain(before[field]);
    const to = plain(after[field]);
    // JSON comparison so 115 and Decimal(115) — and two equal dates — count as
    // unchanged. Both sides have already been through `plain`.
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes[field] = { from, to };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** Enough of an actor to name them in the history. */
type Actor = {
  membershipId: string | null;
  label: string;
};

/**
 * The person behind a server action.
 *
 * `WorkspaceAccess` has the user id, not the membership id, so this resolves
 * the membership and the display name in one query. Cheap, cached per request
 * by `workspaceAccess` upstream in practice, and only ever run on writes.
 */
async function actorFor(access: WorkspaceAccess): Promise<Actor> {
  const membership = await prisma.membership.findFirst({
    where: { userId: access.userId, workspaceId: access.workspaceId },
    select: { id: true, user: { select: { name: true, email: true } } },
  });
  if (!membership) return { membershipId: null, label: "Unknown" };
  return {
    membershipId: membership.id,
    label: membership.user.name ?? membership.user.email,
  };
}

/**
 * Record one thing a person did.
 *
 * Call it AFTER the write commits, with what actually happened. Never inside
 * the transaction: a retried or rolled-back transaction would leave a history
 * entry describing a change the database does not have.
 */
export async function recordActivity(
  access: WorkspaceAccess,
  input: ActivityInput | ActivityInput[],
): Promise<void> {
  const entries = Array.isArray(input) ? input : [input];
  if (entries.length === 0) return;
  try {
    const actor = await actorFor(access);
    await prisma.activityLog.createMany({
      data: entries.map((e) => ({
        workspaceId: access.workspaceId,
        actorMembershipId: actor.membershipId,
        actorLabel: actor.label,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        entityLabel: e.entityLabel ?? null,
        summary: e.summary,
        changes: (e.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        groupId: e.groupId ?? null,
      })),
    });
  } catch (err) {
    // Deliberately swallowed. The write this describes already succeeded, and
    // failing the action now would tell the user their order didn't save when
    // it did. Logged so a broken audit trail is still discoverable.
    console.error("[activity] failed to record", err);
  }
}

/**
 * Record something no logged-in person did: the WooCommerce webhook, the
 * nightly backup cron. They write real data, and a history that skipped them
 * would have gaps nobody could explain.
 */
export async function recordSystemActivity(
  workspaceId: string,
  actorLabel: string,
  input: ActivityInput | ActivityInput[],
): Promise<void> {
  const entries = Array.isArray(input) ? input : [input];
  if (entries.length === 0) return;
  try {
    await prisma.activityLog.createMany({
      data: entries.map((e) => ({
        workspaceId,
        actorMembershipId: null,
        actorLabel,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        entityLabel: e.entityLabel ?? null,
        summary: e.summary,
        changes: (e.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        groupId: e.groupId ?? null,
      })),
    });
  } catch (err) {
    console.error("[activity] failed to record system entry", err);
  }
}

/** Human labels for the entities that appear in the history. */
export const ENTITY_LABEL: Record<string, string> = {
  Order: "Order",
  OrderItem: "Order item",
  OrderGift: "Gift",
  Return: "Return",
  OrderLead: "Call list",
  Product: "Product",
  ProductVariant: "Variant",
  ProductCategory: "Category",
  Purchase: "Purchase",
  Supplier: "Supplier",
  Customer: "Customer",
  Courier: "Courier",
  CourierZone: "Courier zone",
  Partner: "Partner",
  PartnerTxn: "Partner transaction",
  ProfitDistribution: "Profit distribution",
  TreasuryEntry: "Treasury entry",
  InternalPurchase: "Internal purchase",
  StockAdjustment: "Stock adjustment",
  BoostCampaign: "Campaign",
  BoostAdSet: "Ad set",
  BoostDailySpend: "Ad spend",
  Membership: "Team member",
  Invite: "Invite",
  Workspace: "Workspace",
};

/** Field names as a shopkeeper would read them, not as the schema spells them. */
export const FIELD_LABEL: Record<string, string> = {
  status: "Status",
  paymentStatus: "Payment",
  paymentMethod: "Payment method",
  amountPaid: "Amount paid",
  deliveryCharge: "Delivery charge",
  deliveryCost: "Courier cost",
  codFeeCost: "COD fee",
  cancelledCollected: "Collected on cancellation",
  packagingCost: "Packaging",
  giftCost: "Gift cost",
  discount: "Discount",
  weightKg: "Weight (kg)",
  courierId: "Courier",
  courierZoneId: "Courier zone",
  courierTrackingId: "Tracking ID",
  cashInTreasury: "Cash deposited",
  boostCampaignId: "Campaign",
  source: "Came from",
  heldByMembershipId: "Held by",
  customerId: "Customer",
  date: "Date",
  isGiveaway: "Free giveaway",
  notes: "Notes",
  name: "Name",
  phone: "Phone",
  address: "Address",
  unitPrice: "Unit price",
  unitCost: "Unit cost",
  quantity: "Quantity",
  role: "Role",
  permissions: "Permissions",
  profitSharePercent: "Profit share %",
  amount: "Amount",
  cost: "Cost",
  spreadMonths: "Spread over months",
  lowStockThreshold: "Low stock threshold",
  expiryTracked: "Expiry tracked",
  unitsPerPack: "Units per pack",
  weightGrams: "Weight (g)",
  category: "Category",
  sku: "SKU",
  barcode: "Barcode",
  budget: "Budget",
  startDate: "Start date",
  endDate: "End date",
  objective: "Objective",
  channel: "Channel",
  callStatus: "Call status",
  fulfilmentStatus: "Fulfilment",
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

export function entityLabel(entity: string): string {
  return ENTITY_LABEL[entity] ?? entity;
}
