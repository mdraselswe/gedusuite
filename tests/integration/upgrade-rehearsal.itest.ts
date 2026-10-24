import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resolveWooConfig } from "@/lib/woo-config";
import { entitlementOf } from "@/lib/billing";
import { resolvePrintProfile } from "@/lib/print-profile";
import { workspaceAccess } from "@/lib/authz";
import { createCustomer } from "@/server/actions/customers";
import { createProduct } from "@/server/actions/products";
import { actAs, fd } from "./harness";

/**
 * The upgrade, rehearsed: the NEW code against a database that was built with
 * the PRODUCTION migrations and old-style rows, and then upgraded. Run only on
 * purpose — it expects that database, it does not build one:
 *
 *   REHEARSAL=1 DATABASE_URL=…/rehearsal npx vitest run -c vitest.integration.config.mts \
 *     tests/integration/upgrade-rehearsal.itest.ts
 *
 * It never resets anything.
 */
describe.skipIf(!process.env.REHEARSAL)("after upgrading a production-shaped database", () => {
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    WOO_WORKSPACE_SLUG: "gedushop",
    WP_URL: "https://wp.example-shop.test",
    WC_CONSUMER_KEY: "ck_env",
    WC_CONSUMER_SECRET: "cs_env",
    BILLING_ENFORCEMENT: "on",
  };

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("an existing owner still gets in, with a cookie issued months ago", async () => {
    await actAs("u_pw", { issuedAt: Math.floor(new Date("2026-06-01").getTime() / 1000) });
    const access = await workspaceAccess("gedushop");
    expect(access?.role).toBe("OWNER");
  });

  it("the shop keeps its website connection from the environment; nobody else gets it", async () => {
    expect((await resolveWooConfig("w_g"))?.source).toBe("env");
    expect(await resolveWooConfig("w_o")).toBeNull();
  });

  it("existing workspaces are founding (unlimited) even with enforcement on, and can write", async () => {
    expect((await entitlementOf("w_g")).plan.key).toBe("LEGACY");
    expect((await entitlementOf("w_g")).state).toBe("active");
    await actAs("u_pw");
    expect((await createCustomer("gedushop", fd({ name: "After upgrade" }))).ok).toBe(true);
    expect(
      (
        await createProduct(
          "gedushop",
          fd({ name: "After upgrade toy", lowStockThreshold: 1, variants: [{ attributes: [] }] }),
        )
      ).ok,
    ).toBe(true);
  });

  it("the shop's gift tag still says what it always said", async () => {
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: "w_g" } });
    const p = resolvePrintProfile(ws);
    expect(p.whatsapp?.display).toBe("01552-958606");
    expect(p.giftQuote).toBe("একবারের বিশ্বাস, বারবারের ভালোবাসা।");
  });

  it("old rows are untouched", async () => {
    const o = await prisma.order.findUniqueOrThrow({ where: { id: "o1" } });
    expect(o.status).toBe("DELIVERED");
    expect(Number(o.deliveryCharge)).toBe(80);
  });
});
