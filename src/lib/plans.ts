/**
 * What can be bought, and what each plan allows.
 *
 * Kept in code on purpose. A price or a limit is a product decision that ships
 * with a deploy and is visible in review; stored as rows it would be something
 * a migration or an admin screen could change silently under paying customers.
 *
 * Money is whole taka. Yearly is priced as ten months — "two months free" —
 * which is a promise that is easy to say and easy to check.
 */

export type PlanKey = "STARTER" | "BUSINESS" | "PRO" | "LEGACY";
export type Cycle = "MONTHLY" | "YEARLY";

export type PlanLimits = {
  /** People in the workspace (members + pending invites count against it). */
  members: number | null;
  /** Orders dated within one calendar month (Asia/Dhaka). */
  ordersPerMonth: number | null;
  products: number | null;
  couriers: number | null;
};

export type Plan = {
  key: PlanKey;
  name: string;
  tagline: string;
  /** Per month, in taka. */
  monthly: number;
  limits: PlanLimits;
  /** Connect a WooCommerce website: leads, catalogue, status mirroring. */
  website: boolean;
  /** Offered for purchase. LEGACY is not. */
  sellable: boolean;
  highlights: string[];
};

const UNLIMITED: PlanLimits = { members: null, ordersPerMonth: null, products: null, couriers: null };

export const PLANS: Record<PlanKey, Plan> = {
  STARTER: {
    key: "STARTER",
    name: "Starter",
    tagline: "For a one-person shop getting its books straight",
    monthly: 499,
    limits: { members: 1, ordersPerMonth: 200, products: 150, couriers: 1 },
    website: false,
    sellable: true,
    highlights: [
      "1 user",
      "200 orders a month",
      "Stock, orders, courier & cash tracking",
      "Daily backup",
    ],
  },
  BUSINESS: {
    key: "BUSINESS",
    name: "Business",
    tagline: "For a growing team and partners sharing profit",
    monthly: 1299,
    limits: { members: 3, ordersPerMonth: 1000, products: 1000, couriers: 3 },
    website: false,
    sellable: true,
    highlights: [
      "3 users, roles & permissions",
      "1,000 orders a month",
      "Partner capital & profit sharing",
      "Ad-spend attribution",
    ],
  },
  PRO: {
    key: "PRO",
    name: "Pro",
    tagline: "For busy shops with a website and a team",
    monthly: 2999,
    limits: { members: 10, ordersPerMonth: null, products: null, couriers: 10 },
    website: true,
    sellable: true,
    highlights: [
      "10 users",
      "Unlimited orders & products",
      "WooCommerce website connection",
      "Priority support",
    ],
  },
  LEGACY: {
    key: "LEGACY",
    name: "Founding workspace",
    tagline: "Existing workspace — everything included",
    monthly: 0,
    limits: UNLIMITED,
    website: true,
    sellable: false,
    highlights: ["Everything included"],
  },
};

export const SELLABLE: PlanKey[] = (Object.keys(PLANS) as PlanKey[]).filter((k) => PLANS[k].sellable);

/** Months of price charged for one cycle. */
export function monthsCharged(cycle: Cycle): number {
  return cycle === "YEARLY" ? 10 : 1;
}

/** Calendar months of access one payment buys. */
export function monthsGranted(cycle: Cycle): number {
  return cycle === "YEARLY" ? 12 : 1;
}

export function priceFor(plan: PlanKey, cycle: Cycle): number {
  return PLANS[plan].monthly * monthsCharged(cycle);
}

export const TRIAL_DAYS = 14;
/** After a paid period ends, how long full access continues before read-only. */
export const GRACE_DAYS = 7;
export const TRIAL_PLAN: PlanKey = "BUSINESS";

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === "string" && v in PLANS;
}

// ── Lifecycle ──────────────────────────────────────────────────────────

export type SubscriptionFacts = {
  planKey: string;
  status: "TRIALING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
};

/**
 *  - `active`   paid up (or a founding workspace)
 *  - `trial`    inside the free trial
 *  - `grace`    paid period ended recently — still full access, with a warning
 *  - `readonly` nothing can be written; every record can still be read/exported
 */
export type AccessState = "active" | "trial" | "grace" | "readonly";

const DAY = 86_400_000;

export function accessState(sub: SubscriptionFacts | null, now: Date = new Date()): AccessState {
  // No row, or the founding plan: exactly how the app behaved before billing.
  if (!sub || sub.planKey === "LEGACY") return "active";
  if (sub.status === "SUSPENDED" || sub.status === "CANCELLED") return "readonly";

  if (sub.status === "TRIALING") {
    if (!sub.trialEndsAt) return "trial";
    return now.getTime() <= sub.trialEndsAt.getTime() ? "trial" : "readonly";
  }

  // ACTIVE
  if (!sub.currentPeriodEnd) return "active";
  const end = sub.currentPeriodEnd.getTime();
  if (now.getTime() <= end) return "active";
  if (now.getTime() <= end + GRACE_DAYS * DAY) return "grace";
  return "readonly";
}

/** The plan whose limits apply right now. A lapsed workspace keeps its plan's limits. */
export function effectivePlan(sub: SubscriptionFacts | null): Plan {
  if (!sub) return PLANS.LEGACY;
  if (sub.status === "TRIALING") return PLANS[TRIAL_PLAN];
  return isPlanKey(sub.planKey) ? PLANS[sub.planKey] : PLANS.LEGACY;
}

/** Whole days until an instant, never negative. */
export function daysLeft(until: Date | null, now: Date = new Date()): number | null {
  if (!until) return null;
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY));
}

/** Add whole calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * When a paid period will end after a payment is approved.
 * Paying early extends from the end of the current period rather than from
 * today, so nobody loses days by renewing ahead of time.
 */
export function nextPeriodEnd(
  currentEnd: Date | null,
  cycle: Cycle,
  now: Date = new Date(),
): Date {
  const start = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  return addMonths(start, monthsGranted(cycle));
}

// ── Limits ─────────────────────────────────────────────────────────────

export type Metric = keyof PlanLimits;

export const METRIC_LABEL: Record<Metric, string> = {
  members: "team members",
  ordersPerMonth: "orders this month",
  products: "products",
  couriers: "couriers",
};

/** Would one more of `metric` fit, given how many there are already? */
export function withinLimit(
  plan: Plan,
  metric: Metric,
  current: number,
): { ok: true } | { ok: false; limit: number } {
  const limit = plan.limits[metric];
  if (limit === null) return { ok: true };
  return current < limit ? { ok: true } : { ok: false, limit };
}
