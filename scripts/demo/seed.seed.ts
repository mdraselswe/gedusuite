/**
 * Builds the demo workspace — the one a prospective customer is shown.
 *
 *   yarn demo:seed
 *
 * Runs through the same server actions the UI calls, against the LOCAL
 * database only (tests/integration/setup.ts refuses anything else). Safe to
 * re-run: it removes the previous demo workspace and its users first and leaves
 * everything else in the database alone.
 *
 * Login:   demo@gedusuite.test / Demo#2026
 * Roles:   partner.demo@…, manager.demo@…, staff.demo@… (same password)
 */
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { buildDataset } from "./dataset";
import { addDemoExtras } from "./extras";

const SLUG = "little-nest";
const PASSWORD = "Demo#2026";

function ymd(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

describe("demo workspace", () => {
  it("is built", async () => {
    // Remove a previous run, and nothing else.
    // The five demo logins are the only users this script ever creates, so
    // they are the only ones it removes.
    const DEMO_EMAILS = [
      "demo@gedusuite.test",
      "partner.demo@gedusuite.test",
      "partner2.demo@gedusuite.test",
      "manager.demo@gedusuite.test",
      "staff.demo@gedusuite.test",
    ];
    await prisma.workspace.deleteMany({ where: { slug: SLUG } });
    await prisma.user.deleteMany({ where: { email: { in: DEMO_EMAILS } } });

    const result = await buildDataset({
      slug: SLUG,
      workspaceName: "Little Nest Baby Shop",
      startDay: ymd(-91),
      days: 90,
      emailDomain: "demo.gedusuite.test",
      ordersPerDay: 3,
      password: PASSWORD,
      emails: {
        owner: DEMO_EMAILS[0],
        partnerA: DEMO_EMAILS[1],
        partnerB: DEMO_EMAILS[2],
        manager: DEMO_EMAILS[3],
        staff: DEMO_EMAILS[4],
      },
    });
    await addDemoExtras(result);

    // A paid-up Pro plan, so every screen — billing and website included — has
    // something to show.
    await prisma.subscription.upsert({
      where: { workspaceId: result.workspaceId },
      create: {
        workspaceId: result.workspaceId,
        planKey: "PRO",
        status: "ACTIVE",
        cycle: "YEARLY",
        currentPeriodEnd: new Date(Date.now() + 300 * 86_400_000),
      },
      update: {
        planKey: "PRO",
        status: "ACTIVE",
        cycle: "YEARLY",
        currentPeriodEnd: new Date(Date.now() + 300 * 86_400_000),
      },
    });
    await prisma.workspace.update({
      where: { id: result.workspaceId },
      data: {
        websiteUrl: "littlenest.example",
        // The shop's own wording for gift tags and the leaflet — a fictional
        // shop, so the demo shows what a real one would fill in.
        printProfile: {
          facebook: "facebook.com/littlenest.bd",
          whatsapp: "01711-000000",
          tagline: "মায়ের ভরসা, শিশুর যত্ন",
          headline: "শিশুর যত্নের সব দরকারি জিনিস\nএক জায়গায়",
        },
      },
    });

    const orders = await prisma.order.count({ where: { workspaceId: result.workspaceId } });
    expect(orders).toBeGreaterThan(150);
    console.log(`[demo] ${orders} orders · login demo@gedusuite.test / ${PASSWORD} · /${SLUG}`);
  });
});
