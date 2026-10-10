import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { denyCron } from "@/lib/cron-auth";
import { GRACE_DAYS, PLANS, daysLeft, isPlanKey } from "@/lib/plans";
import { tellOwners } from "@/lib/billing-admin";

/**
 * Daily reminders about trials and renewals.
 *
 * Nothing here changes a subscription: access state is worked out from the
 * dates every time it is asked (lib/plans.accessState), so a missed cron run
 * can never leave a workspace stuck in the wrong state. This only tells people
 * what is coming. Run once a day, each threshold matches exactly one day, so a
 * reminder goes out once.
 */
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const denied = denyCron(req);
  if (denied) return denied;

  const subs = await prisma.subscription.findMany({
    where: { status: { in: ["TRIALING", "ACTIVE"] }, planKey: { not: "LEGACY" } },
    select: {
      workspaceId: true,
      planKey: true,
      status: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
    },
  });

  const now = new Date();
  let sent = 0;

  for (const s of subs) {
    const plan = isPlanKey(s.planKey) ? PLANS[s.planKey].name : s.planKey;
    const trial = s.status === "TRIALING";
    const until = trial ? s.trialEndsAt : s.currentPeriodEnd;
    if (!until) continue;
    const left = daysLeft(until, now) ?? 0;
    const lapsedDays = Math.floor((now.getTime() - until.getTime()) / 86_400_000);

    let msg: { message: string; subject: string; body: string } | null = null;

    if (left === 3 || left === 1) {
      msg = trial
        ? {
            message: `Your free trial ends in ${left} day(s). Choose a plan to keep going.`,
            subject: `Your GeduSuite trial ends in ${left} day(s)`,
            body: `Your free trial ends in ${left} day(s). Choose a plan in Billing to keep adding orders and records.`,
          }
        : {
            message: `Your ${plan} plan renews in ${left} day(s).`,
            subject: `Your GeduSuite plan ends in ${left} day(s)`,
            body: `Your ${plan} plan ends in ${left} day(s). Renew in Billing to keep everything running.`,
          };
    } else if (until.getTime() <= now.getTime() && lapsedDays === 0 && !trial) {
      msg = {
        message: `Your ${plan} plan has ended. You have ${GRACE_DAYS} days before the workspace becomes read-only.`,
        subject: "Your GeduSuite plan has ended",
        body: `Your ${plan} plan ended today. Everything keeps working for ${GRACE_DAYS} more days; after that the workspace becomes read-only until you renew. Nothing is deleted.`,
      };
    } else if (!trial && lapsedDays === GRACE_DAYS) {
      msg = {
        message: "Your workspace is now read-only. Renew to continue; nothing was removed.",
        subject: "Your GeduSuite workspace is now read-only",
        body: "The grace period has ended and the workspace is read-only. Renew in Billing to continue. Your data is safe and can still be viewed and exported.",
      };
    } else if (trial && until.getTime() <= now.getTime() && lapsedDays === 0) {
      msg = {
        message: "Your free trial has ended. The workspace is read-only until you choose a plan.",
        subject: "Your GeduSuite trial has ended",
        body: "Your free trial has ended and the workspace is read-only until you choose a plan. Your data is safe and can still be viewed and exported.",
      };
    }

    if (msg) {
      await tellOwners(s.workspaceId, msg);
      sent++;
    }
  }

  return NextResponse.json({ ok: true, checked: subs.length, sent });
}
