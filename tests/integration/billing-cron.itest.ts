import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { clearOutbox, outbox } from "@/lib/mailer";
import { GET } from "@/app/api/cron/billing/route";
import { createUser, createWorkspaceWithOwner, resetDatabase } from "./harness";

const DAY = 86_400_000;
let saved: string | undefined;

const run = () =>
  GET(
    new NextRequest("http://localhost/api/cron/billing", {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    }),
  );

beforeAll(async () => {
  saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "cron-test-secret";
  await resetDatabase();
});
afterAll(() => {
  if (saved === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved;
});

describe("billing reminders", () => {
  it("rejects callers without the cron secret", async () => {
    const res = await GET(new NextRequest("http://localhost/api/cron/billing"));
    expect(res.status).toBe(401);
  });

  it("reminds once at the right moments, never touches founding workspaces", async () => {
    const owner = await createUser("o@cron.test", "Owner");
    const mk = async (slug: string) => createWorkspaceWithOwner(slug, slug, owner.id);
    const trial3 = await mk("trial-3");
    const trialDone = await mk("trial-done");
    const paid1 = await mk("paid-1");
    const grace0 = await mk("grace-0");
    const quiet = await mk("quiet");
    const legacy = await mk("legacy");

    const now = Date.now();
    await prisma.subscription.createMany({
      data: [
        // 3 days left → reminder
        { workspaceId: trial3.id, planKey: "BUSINESS", status: "TRIALING", trialEndsAt: new Date(now + 2.5 * DAY) },
        // ended today → "read-only" notice
        { workspaceId: trialDone.id, planKey: "BUSINESS", status: "TRIALING", trialEndsAt: new Date(now - 0.5 * DAY) },
        // 1 day left → reminder
        { workspaceId: paid1.id, planKey: "PRO", status: "ACTIVE", currentPeriodEnd: new Date(now + 0.5 * DAY) },
        // ended today → grace notice
        { workspaceId: grace0.id, planKey: "STARTER", status: "ACTIVE", currentPeriodEnd: new Date(now - 0.5 * DAY) },
        // plenty of time → nothing
        { workspaceId: quiet.id, planKey: "BUSINESS", status: "ACTIVE", currentPeriodEnd: new Date(now + 20 * DAY) },
        // founding → nothing, ever
        { workspaceId: legacy.id, planKey: "LEGACY", status: "ACTIVE", currentPeriodEnd: new Date(now - 100 * DAY) },
      ],
    });

    clearOutbox();
    const res = await run();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sent).toBe(4);

    const notified = async (id: string) =>
      (await prisma.notification.count({ where: { workspaceId: id } })) > 0;
    expect(await notified(trial3.id)).toBe(true);
    expect(await notified(trialDone.id)).toBe(true);
    expect(await notified(paid1.id)).toBe(true);
    expect(await notified(grace0.id)).toBe(true);
    expect(await notified(quiet.id)).toBe(false);
    expect(await notified(legacy.id)).toBe(false);
    expect(outbox().length).toBe(4);
  });
});
