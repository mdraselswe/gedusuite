import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { dhakaDayStart, dhakaMonthStart } from "@/lib/dhaka-time";
import {
  METRIC_LABEL,
  PLANS,
  TRIAL_DAYS,
  TRIAL_PLAN,
  accessState,
  daysLeft,
  effectivePlan,
  withinLimit,
  type AccessState,
  type Metric,
  type Plan,
  type SubscriptionFacts,
} from "@/lib/plans";

/**
 * The database side of plans: what a workspace's subscription says, what it has
 * used, and whether one more of something is allowed.
 *
 * Two safety properties that matter more than any feature here:
 *
 *  1. It is OFF until BILLING_ENFORCEMENT=on. While off, every check returns
 *     "allowed" without touching the database, so deploying this code changes
 *     nothing about how an existing workspace behaves.
 *  2. It fails OPEN. If the subscription lookup errors, the person carries on.
 *     A billing glitch must never be the reason a shop cannot enter an order.
 */

export function billingEnforced(): boolean {
  return process.env.BILLING_ENFORCEMENT === "on";
}

export type Entitlement = {
  plan: Plan;
  state: AccessState;
  status: SubscriptionFacts["status"] | "NONE";
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cycle: "MONTHLY" | "YEARLY" | null;
  /** Days left of whichever of trial / paid period is running. */
  daysLeft: number | null;
};

const LEGACY_ENTITLEMENT: Entitlement = {
  plan: PLANS.LEGACY,
  state: "active",
  status: "NONE",
  trialEndsAt: null,
  currentPeriodEnd: null,
  cycle: null,
  daysLeft: null,
};

/** One lookup per request however many guards ask. */
export const entitlementOf = cache(async (workspaceId: string): Promise<Entitlement> => {
  try {
    const sub = await prisma.subscription.findUnique({ where: { workspaceId } });
    if (!sub) return LEGACY_ENTITLEMENT;
    const facts: SubscriptionFacts = {
      planKey: sub.planKey,
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
    };
    const until = sub.status === "TRIALING" ? sub.trialEndsAt : sub.currentPeriodEnd;
    return {
      plan: effectivePlan(facts),
      state: accessState(facts),
      status: sub.status,
      trialEndsAt: sub.trialEndsAt,
      currentPeriodEnd: sub.currentPeriodEnd,
      cycle: sub.cycle,
      daysLeft: daysLeft(until),
    };
  } catch {
    return LEGACY_ENTITLEMENT;
  }
});

export type Usage = Record<Metric, number>;

export async function usageOf(workspaceId: string): Promise<Usage> {
  const monthStart = dhakaDayStart(dhakaMonthStart());
  const [members, invites, ordersPerMonth, products, couriers] = await Promise.all([
    prisma.membership.count({ where: { workspaceId } }),
    prisma.invite.count({ where: { workspaceId, acceptedAt: null } }),
    prisma.order.count({ where: { workspaceId, date: { gte: monthStart } } }),
    prisma.product.count({ where: { workspaceId } }),
    prisma.courier.count({ where: { workspaceId } }),
  ]);
  return { members: members + invites, ordersPerMonth, products, couriers };
}

type Verdict = { ok: true } | { ok: false; error: string };

/**
 * May this workspace add one more `metric`?
 * Refuses with a message that says what the limit is and how to lift it.
 */
export async function assertWithinPlan(workspaceId: string, metric: Metric): Promise<Verdict> {
  if (!billingEnforced()) return { ok: true };
  try {
    const ent = await entitlementOf(workspaceId);
    if (ent.state === "readonly") return readonlyVerdict(ent);
    if (ent.plan.limits[metric] === null) return { ok: true };

    const usage = await usageOf(workspaceId);
    const verdict = withinLimit(ent.plan, metric, usage[metric]);
    if (verdict.ok) return verdict;
    return {
      ok: false,
      error:
        `Your ${ent.plan.name} plan includes ${verdict.limit.toLocaleString("en")} ${METRIC_LABEL[metric]} ` +
        `and you have reached it. Upgrade in Settings → Billing to add more.`,
    };
  } catch {
    return { ok: true };
  }
}

/** Is this workspace allowed to write at all right now? */
export async function assertWritable(workspaceId: string): Promise<Verdict> {
  if (!billingEnforced()) return { ok: true };
  try {
    const ent = await entitlementOf(workspaceId);
    return ent.state === "readonly" ? readonlyVerdict(ent) : { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Is the website connection part of this workspace's plan? */
export async function assertWebsiteAllowed(workspaceId: string): Promise<Verdict> {
  if (!billingEnforced()) return { ok: true };
  try {
    const ent = await entitlementOf(workspaceId);
    if (ent.plan.website) return { ok: true };
    return {
      ok: false,
      error: `The website connection is part of the Pro plan. Upgrade in Settings → Billing to use it.`,
    };
  } catch {
    return { ok: true };
  }
}

function readonlyVerdict(ent: Entitlement): Verdict {
  const why =
    ent.status === "TRIALING"
      ? "Your free trial has ended"
      : ent.status === "SUSPENDED"
        ? "This workspace has been suspended"
        : ent.status === "CANCELLED"
          ? "This subscription was cancelled"
          : "Your subscription has expired";
  return {
    ok: false,
    error: `${why}, so the workspace is read-only. Everything is still here — choose a plan in Settings → Billing to continue.`,
  };
}

/** Start the free trial for a brand-new workspace. */
export async function startTrial(workspaceId: string, now: Date = new Date()): Promise<void> {
  await prisma.subscription.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      planKey: TRIAL_PLAN,
      status: "TRIALING",
      trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000),
    },
    update: {},
  });
}
