import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { onboardingFor } from "@/lib/onboarding";
import { createProduct } from "@/server/actions/products";
import { createPurchase } from "@/server/actions/purchases";
import { sendSupportMessage } from "@/server/actions/support";
import { prisma } from "@/lib/prisma";
import { clearOutbox, outbox } from "@/lib/mailer";
import { actAs, createUser, createWorkspaceWithOwner, fd, resetDatabase } from "./harness";

let wsId = "";
const slug = "onboard";
let saved: string | undefined;

beforeAll(async () => {
  saved = process.env.BILLING_SUPPORT_EMAIL;
  process.env.BILLING_SUPPORT_EMAIL = "help@suite.test";
  await resetDatabase();
  const owner = await createUser("o@onboard.test", "Owner");
  const ws = await createWorkspaceWithOwner("Onboard Shop", slug, owner.id);
  wsId = ws.id;
  await actAs(owner.id);
});
afterAll(() => {
  if (saved === undefined) delete process.env.BILLING_SUPPORT_EMAIL;
  else process.env.BILLING_SUPPORT_EMAIL = saved;
});

describe("onboarding checklist", () => {
  it("starts empty and ticks off as the shop is built", async () => {
    let o = await onboardingFor(wsId, slug);
    expect(o.show).toBe(true);
    expect(o.progress).toEqual({ done: 0, total: 3 });

    await createProduct(
      slug,
      fd({ name: "Toy", lowStockThreshold: 1, variants: [{ attributes: [], salePrice: 100, unitCost: 60 }] }),
    );
    o = await onboardingFor(wsId, slug);
    expect(o.progress.done).toBe(1);

    const v = await prisma.productVariant.findFirstOrThrow({ where: { product: { workspaceId: wsId } } });
    await createPurchase(slug, fd({ productVariantId: v.id, date: "2026-09-01", unitCost: 60, quantity: 5 }));
    o = await onboardingFor(wsId, slug);
    expect(o.progress.done).toBe(2);
    expect(o.steps.find((s) => s.key === "purchase")?.done).toBe(true);
  });

  it("disappears for an established shop with a single cheap query", async () => {
    const v = await prisma.productVariant.findFirstOrThrow({ where: { product: { workspaceId: wsId } } });
    await prisma.order.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        workspaceId: wsId,
        orderNo: 100 + i,
        date: new Date("2026-09-02"),
      })),
    });
    void v;
    const o = await onboardingFor(wsId, slug);
    expect(o.show).toBe(false);
    expect(o.steps).toEqual([]);
  });
});

describe("support message", () => {
  it("emails the support inbox with the sender and workspace spelled out", async () => {
    clearOutbox();
    const res = await sendSupportMessage(
      slug,
      fd({ subject: "Courier fee looks off", message: "The COD fee on order 12 is more than 1%." }),
    );
    expect(res.ok).toBe(true);
    const mail = outbox().at(-1)!;
    expect(mail.to).toBe("help@suite.test");
    expect(mail.text).toContain("Onboard Shop");
    expect(mail.text).toContain("o@onboard.test");
  });

  it("validates, and a stranger cannot send on a workspace they do not belong to", async () => {
    expect((await sendSupportMessage(slug, fd({ subject: "x", message: "short" }))).ok).toBe(false);
    const other = await createUser("x@other.test", "Other");
    await actAs(other.id);
    const denied = await sendSupportMessage(
      slug,
      fd({ subject: "Hello there", message: "Trying to reach support as someone else." }),
    );
    expect(denied.ok).toBe(false);
  });
});
