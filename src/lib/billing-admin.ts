import { prisma } from "@/lib/prisma";
import { appUrl, actionMail, sendMail } from "@/lib/mailer";
import { PLANS, isPlanKey, nextPeriodEnd, priceFor, type Cycle, type PlanKey } from "@/lib/plans";

/**
 * The money-moving half of billing: turning an approved payment into paid time.
 *
 * Deliberately free of any session or request handling, so the rules can be
 * tested directly and the same code is what the admin screen calls.
 */

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** What an owner is asked to pay, and where. From the environment — never hard-coded. */
export function paymentInstructions() {
  return {
    bkash: process.env.BILLING_BKASH_NUMBER || null,
    nagad: process.env.BILLING_NAGAD_NUMBER || null,
    bank: process.env.BILLING_BANK_DETAILS || null,
    supportPhone: process.env.BILLING_SUPPORT_PHONE || null,
    supportEmail: process.env.BILLING_SUPPORT_EMAIL || null,
  };
}

/** Start (or reuse) a payment request for a plan and cycle. */
export async function createInvoice(
  workspaceId: string,
  planKey: PlanKey,
  cycle: Cycle,
): Promise<Result<{ invoiceId: string; amount: number }>> {
  if (!isPlanKey(planKey) || !PLANS[planKey].sellable) {
    return { ok: false, error: "That plan is not available" };
  }
  const amount = priceFor(planKey, cycle);

  // Requests nobody paid are noise; keep one live request per workspace.
  await prisma.billingInvoice.updateMany({
    where: { workspaceId, status: "PENDING", submittedAt: null },
    data: { status: "VOID" },
  });
  const inv = await prisma.billingInvoice.create({
    data: { workspaceId, planKey, cycle, amount },
  });
  return { ok: true, invoiceId: inv.id, amount };
}

const METHODS = ["BKASH", "NAGAD", "BANK"] as const;

export async function submitPayment(
  workspaceId: string,
  invoiceId: string,
  input: { method: string; senderNumber?: string; trxId: string; note?: string },
): Promise<Result> {
  const method = input.method.toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) {
    return { ok: false, error: "Choose how you paid" };
  }
  const trxId = input.trxId.trim().toUpperCase();
  if (trxId.length < 6 || trxId.length > 40 || !/^[A-Z0-9\-_/]+$/.test(trxId)) {
    return { ok: false, error: "Enter the transaction ID exactly as it appears in your payment message" };
  }

  const inv = await prisma.billingInvoice.findFirst({ where: { id: invoiceId, workspaceId } });
  if (!inv) return { ok: false, error: "Payment request not found" };
  if (inv.status !== "PENDING") return { ok: false, error: "This payment request is already closed" };

  // One payment cannot buy two invoices.
  const reused = await prisma.billingInvoice.findFirst({
    where: { trxId, id: { not: invoiceId }, status: { in: ["PENDING", "PAID"] } },
    select: { id: true },
  });
  if (reused) return { ok: false, error: "That transaction ID has already been used" };

  await prisma.billingInvoice.update({
    where: { id: invoiceId },
    data: {
      method,
      trxId,
      senderNumber: input.senderNumber?.trim().slice(0, 20) || null,
      note: input.note?.trim().slice(0, 300) || null,
      submittedAt: new Date(),
    },
  });
  return { ok: true };
}

/**
 * Settle a submitted payment: the invoice is paid and the subscription moves.
 *
 * Paying before the current period ends extends from its end, so renewing early
 * costs no days. Paying after a lapse starts from today. Plan and cycle become
 * what was bought.
 */
export async function approveInvoice(
  invoiceId: string,
  reviewerId: string,
  now: Date = new Date(),
): Promise<Result<{ workspaceId: string; periodEnd: Date }>> {
  const inv = await prisma.billingInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) return { ok: false, error: "Invoice not found" };
  if (inv.status !== "PENDING") return { ok: false, error: "This invoice is already settled" };
  if (!inv.submittedAt) return { ok: false, error: "The customer has not submitted a transaction ID yet" };

  const sub = await prisma.subscription.findUnique({ where: { workspaceId: inv.workspaceId } });
  const keepFrom = sub && sub.status === "ACTIVE" ? sub.currentPeriodEnd : null;
  const periodEnd = nextPeriodEnd(keepFrom, inv.cycle, now);

  // Claim the invoice first: two admins clicking at once settle it once.
  const claimed = await prisma.billingInvoice.updateMany({
    where: { id: invoiceId, status: "PENDING" },
    data: { status: "PAID", reviewedAt: now, reviewedBy: reviewerId },
  });
  if (claimed.count !== 1) return { ok: false, error: "This invoice is already settled" };

  await prisma.subscription.upsert({
    where: { workspaceId: inv.workspaceId },
    create: {
      workspaceId: inv.workspaceId,
      planKey: inv.planKey,
      status: "ACTIVE",
      cycle: inv.cycle,
      currentPeriodEnd: periodEnd,
    },
    update: {
      planKey: inv.planKey,
      status: "ACTIVE",
      cycle: inv.cycle,
      currentPeriodEnd: periodEnd,
      trialEndsAt: null,
    },
  });

  await tellOwners(inv.workspaceId, {
    message: `Payment received — your ${PLANS[inv.planKey as PlanKey]?.name ?? inv.planKey} plan is active until ${periodEnd.toISOString().slice(0, 10)}.`,
    subject: "Payment received — thank you",
    body: `We confirmed your payment of ৳${Number(inv.amount).toLocaleString("en")}. Your plan is active until ${periodEnd.toISOString().slice(0, 10)}.`,
  });

  return { ok: true, workspaceId: inv.workspaceId, periodEnd };
}

export async function rejectInvoice(
  invoiceId: string,
  reviewerId: string,
  reason: string,
): Promise<Result> {
  const why = reason.trim().slice(0, 300);
  if (!why) return { ok: false, error: "Give the customer a reason" };
  const inv = await prisma.billingInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) return { ok: false, error: "Invoice not found" };
  const res = await prisma.billingInvoice.updateMany({
    where: { id: invoiceId, status: "PENDING" },
    data: { status: "REJECTED", rejectReason: why, reviewedAt: new Date(), reviewedBy: reviewerId },
  });
  if (res.count !== 1) return { ok: false, error: "This invoice is already settled" };

  await tellOwners(inv.workspaceId, {
    message: `Payment could not be confirmed: ${why}`,
    subject: "We could not confirm your payment",
    body: `We could not confirm the payment you submitted: ${why}. Please check the transaction ID and submit it again.`,
  });
  return { ok: true };
}

/** Admin override: set a plan/status/period directly (gifts, corrections, suspensions). */
export async function setSubscription(
  workspaceId: string,
  change: {
    planKey?: string;
    status?: "TRIALING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
    /** Add this many days to the running trial / paid period (from today if lapsed). */
    extendDays?: number;
    notes?: string;
  },
  now: Date = new Date(),
): Promise<Result> {
  if (change.planKey && !isPlanKey(change.planKey)) return { ok: false, error: "Unknown plan" };
  const sub = await prisma.subscription.findUnique({ where: { workspaceId } });

  const data: {
    planKey?: string;
    status?: "TRIALING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
    trialEndsAt?: Date | null;
    currentPeriodEnd?: Date | null;
    notes?: string;
  } = {};
  if (change.planKey) data.planKey = change.planKey;
  if (change.status) data.status = change.status;
  if (change.notes !== undefined) data.notes = change.notes.slice(0, 500);

  if (change.extendDays && change.extendDays !== 0) {
    const status = change.status ?? sub?.status ?? "ACTIVE";
    const base = (status === "TRIALING" ? sub?.trialEndsAt : sub?.currentPeriodEnd) ?? now;
    const from = base.getTime() > now.getTime() ? base : now;
    const to = new Date(from.getTime() + change.extendDays * 86_400_000);
    if (status === "TRIALING") data.trialEndsAt = to;
    else data.currentPeriodEnd = to;
  }

  await prisma.subscription.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      planKey: data.planKey ?? "BUSINESS",
      status: data.status ?? "ACTIVE",
      trialEndsAt: data.trialEndsAt ?? null,
      currentPeriodEnd: data.currentPeriodEnd ?? null,
      notes: data.notes ?? null,
    },
    update: data,
  });
  return { ok: true };
}

async function tellOwners(
  workspaceId: string,
  msg: { message: string; subject: string; body: string },
) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      slug: true,
      memberships: {
        where: { role: "OWNER" },
        select: { user: { select: { email: true } } },
      },
    },
  });
  if (!ws) return;
  await prisma.notification
    .create({
      data: {
        workspaceId,
        type: "GENERAL",
        message: msg.message,
        link: `/${ws.slug}/settings/billing`,
      },
    })
    .catch(() => undefined);
  for (const m of ws.memberships) {
    await sendMail(
      actionMail({
        to: m.user.email,
        subject: msg.subject,
        heading: msg.subject,
        body: msg.body,
        buttonLabel: "Open billing",
        url: `${appUrl()}/${ws.slug}/settings/billing`,
      }),
    ).catch(() => undefined);
  }
}

export { tellOwners };
