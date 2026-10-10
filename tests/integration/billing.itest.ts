import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { createProduct } from "@/server/actions/products";
import { createCourier } from "@/server/actions/couriers";
import { inviteMember } from "@/server/actions/team";
import { backupNow } from "@/server/actions/backup";
import { saveWebsiteIntegration } from "@/server/actions/integrations";
import { createWorkspace } from "@/server/actions/workspace";
import { startCheckout, submitPaymentProof, cancelPaymentRequest } from "@/server/actions/billing";
import { approvePayment, rejectPayment, adminSetSubscription } from "@/server/actions/admin";
import { approveInvoice } from "@/lib/billing-admin";
import { entitlementOf, usageOf } from "@/lib/billing";
import { isPlatformAdminEmail } from "@/lib/platform-admin";
import { actAs, createUser, createWorkspaceWithOwner, fd, resetDatabase } from "./harness";

const productForm = (name: string) =>
  fd({ name, lowStockThreshold: 1, variants: [{ attributes: [], salePrice: 100, unitCost: 60 }] });

const courierInput = (name: string) => ({
  name,
  baseWeightKg: 1,
  extraKgRate: 20,
  codFeePercent: 1,
  codFeeBase: "NET" as const,
  returnChargeType: "NONE" as const,
  returnChargeValue: 0,
  isDefault: false,
  isActive: true,
  zones: [{ name: "All", rate: 60, bands: [] }],
});

let ownerId = "";
let adminId = "";
let wsId = "";
const slug = "bill-shop";
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ["BILLING_ENFORCEMENT", "PLATFORM_ADMIN_EMAILS"]) savedEnv[k] = process.env[k];
  process.env.PLATFORM_ADMIN_EMAILS = "boss@platform.test";
  await resetDatabase();
  const owner = await createUser("owner@bill.test", "Bill Owner");
  const boss = await createUser("boss@platform.test", "Platform Boss");
  ownerId = owner.id;
  adminId = boss.id;
  const ws = await createWorkspaceWithOwner("Bill Shop", slug, owner.id);
  wsId = ws.id;
  await actAs(owner.id);
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("with enforcement OFF nothing changes", () => {
  it("a workspace with no subscription row writes freely and has no limits", async () => {
    delete process.env.BILLING_ENFORCEMENT;
    expect((await createCourier(slug, courierInput("A"))).ok).toBe(true);
    expect((await createCourier(slug, courierInput("B"))).ok).toBe(true);
    expect((await createCourier(slug, courierInput("C"))).ok).toBe(true);
    const ent = await entitlementOf(wsId);
    expect(ent.plan.key).toBe("LEGACY");
    expect(ent.state).toBe("active");
  });

  it("even an expired trial is ignored while enforcement is off", async () => {
    await prisma.subscription.create({
      data: { workspaceId: wsId, planKey: "BUSINESS", status: "TRIALING", trialEndsAt: new Date(Date.now() - 86_400_000) },
    });
    expect((await createProduct(slug, productForm("Free Toy"))).ok).toBe(true);
  });
});

describe("with enforcement ON", () => {
  beforeAll(() => {
    process.env.BILLING_ENFORCEMENT = "on";
  });

  it("an expired trial makes the workspace read-only, with a plain reason", async () => {
    const res = await createProduct(slug, productForm("Blocked Toy"));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("free trial has ended");
    // reading and backing up still work
    expect((await entitlementOf(wsId)).state).toBe("readonly");
    expect((await backupNow(slug)).ok).toBe(true);
  });

  it("a running trial gets Business limits; Starter limits bite", async () => {
    await prisma.subscription.update({
      where: { workspaceId: wsId },
      data: { planKey: "STARTER", status: "ACTIVE", trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000) },
    });
    // Starter allows 1 courier; three exist already, so a fourth is refused
    const c = await createCourier(slug, courierInput("D"));
    expect(c.ok).toBe(false);
    expect((c as { error: string }).error).toContain("Starter plan includes 1 couriers");
    // and one member (the owner), so an invitation is refused
    const inv = await inviteMember(fd({ slug, email: "new@bill.test", role: "STAFF" }));
    expect(inv.ok).toBe(false);
  });

  it("the website connection is a Pro feature", async () => {
    const res = await saveWebsiteIntegration(
      slug,
      fd({ url: "https://shop.example.com", consumerKey: "ck_1", consumerSecret: "cs_1" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("Pro plan");

    await prisma.subscription.update({ where: { workspaceId: wsId }, data: { planKey: "PRO" } });
    expect(
      (
        await saveWebsiteIntegration(
          slug,
          fd({ url: "https://shop.example.com", consumerKey: "ck_1", consumerSecret: "cs_1" }),
        )
      ).ok,
    ).toBe(true);
  });

  it("a founding (LEGACY) workspace is never limited, whatever its dates say", async () => {
    await prisma.subscription.update({
      where: { workspaceId: wsId },
      data: { planKey: "LEGACY", status: "ACTIVE", currentPeriodEnd: new Date("2020-01-01") },
    });
    expect((await createProduct(slug, productForm("Legacy Toy"))).ok).toBe(true);
    expect((await createCourier(slug, courierInput("E"))).ok).toBe(true);
  });

  it("grace period: lapsed by 3 days still writes; by 10 days is read-only", async () => {
    await prisma.subscription.update({
      where: { workspaceId: wsId },
      data: { planKey: "BUSINESS", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() - 3 * 86_400_000) },
    });
    expect((await createProduct(slug, productForm("Grace Toy"))).ok).toBe(true);
    await prisma.subscription.update({
      where: { workspaceId: wsId },
      data: { currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000) },
    });
    expect((await createProduct(slug, productForm("Late Toy"))).ok).toBe(false);
  });

  it("usage counts members, pending invites, orders this month, products and couriers", async () => {
    const u = await usageOf(wsId);
    expect(u.members).toBeGreaterThanOrEqual(1);
    expect(u.couriers).toBeGreaterThanOrEqual(3);
    expect(u.products).toBeGreaterThanOrEqual(1);
  });
});

describe("paying by bKash/Nagad, confirmed by a platform admin", () => {
  let invoiceId = "";

  it("a lapsed owner can still start checkout and submit proof", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    await actAs(ownerId);
    const started = await startCheckout(slug, fd({ plan: "BUSINESS", cycle: "MONTHLY" }));
    expect(started.ok).toBe(true);
    invoiceId = (started as { invoiceId: string }).invoiceId;

    const inv = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(Number(inv.amount)).toBe(1299);
    expect(inv.status).toBe("PENDING");

    const bad = await submitPaymentProof(slug, fd({ invoiceId, method: "BKASH", trxId: "x" }));
    expect(bad.ok).toBe(false);

    const paid = await submitPaymentProof(
      slug,
      fd({ invoiceId, method: "BKASH", senderNumber: "01711000000", trxId: "9ab12cd34e" }),
    );
    expect(paid.ok).toBe(true);
  });

  it("the same transaction ID cannot buy a second invoice", async () => {
    const second = await startCheckout(slug, fd({ plan: "PRO", cycle: "MONTHLY" }));
    const id2 = (second as { invoiceId: string }).invoiceId;
    const dup = await submitPaymentProof(slug, fd({ invoiceId: id2, method: "BKASH", trxId: "9AB12CD34E" }));
    expect(dup.ok).toBe(false);
    expect((await cancelPaymentRequest(slug, id2)).ok).toBe(true);
  });

  it("only a platform admin can approve; the owner cannot approve their own payment", async () => {
    await actAs(ownerId);
    expect((await approvePayment(invoiceId)).ok).toBe(false);
    expect(isPlatformAdminEmail("owner@bill.test")).toBe(false);
    expect(isPlatformAdminEmail("BOSS@platform.test")).toBe(true);
  });

  it("approval activates the plan for a month, writes work again, and cannot repeat", async () => {
    await actAs(adminId);
    const ok = await approvePayment(invoiceId);
    expect(ok.ok).toBe(true);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId: wsId } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.planKey).toBe("BUSINESS");
    const days = (sub.currentPeriodEnd!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);

    const inv = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe("PAID");

    await actAs(ownerId);
    expect((await createProduct(slug, productForm("Renewed Toy"))).ok).toBe(true);

    // an owner is told
    const note = await prisma.notification.findFirst({
      where: { workspaceId: wsId, message: { contains: "Payment received" } },
    });
    expect(note).not.toBeNull();

    const again = await approveInvoice(invoiceId, adminId);
    expect(again.ok).toBe(false);
  });

  it("renewing early extends from the end of the current period", async () => {
    const before = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId: wsId } });
    await actAs(ownerId);
    const started = await startCheckout(slug, fd({ plan: "BUSINESS", cycle: "YEARLY" }));
    const id = (started as { invoiceId: string }).invoiceId;
    const inv = await prisma.billingInvoice.findUniqueOrThrow({ where: { id } });
    expect(Number(inv.amount)).toBe(12990);
    await submitPaymentProof(slug, fd({ invoiceId: id, method: "NAGAD", trxId: "NAG-000111" }));
    await actAs(adminId);
    expect((await approvePayment(id)).ok).toBe(true);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId: wsId } });
    const gained = (after.currentPeriodEnd!.getTime() - before.currentPeriodEnd!.getTime()) / 86_400_000;
    expect(gained).toBeGreaterThan(364);
    expect(gained).toBeLessThan(367);
  });

  it("rejection tells the owner why and changes nothing", async () => {
    await actAs(ownerId);
    const started = await startCheckout(slug, fd({ plan: "STARTER", cycle: "MONTHLY" }));
    const id = (started as { invoiceId: string }).invoiceId;
    await submitPaymentProof(slug, fd({ invoiceId: id, method: "BANK", trxId: "BANK-778899" }));
    const before = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId: wsId } });
    await actAs(adminId);
    expect((await rejectPayment(id, "")).ok).toBe(false);
    expect((await rejectPayment(id, "Amount does not match")).ok).toBe(true);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId: wsId } });
    expect(after.planKey).toBe(before.planKey);
    expect(after.currentPeriodEnd?.getTime()).toBe(before.currentPeriodEnd?.getTime());
  });

  it("admin can suspend and extend", async () => {
    await actAs(adminId);
    expect((await adminSetSubscription(wsId, { status: "SUSPENDED" })).ok).toBe(true);
    expect((await entitlementOf(wsId)).state).toBe("readonly");
    expect((await adminSetSubscription(wsId, { status: "ACTIVE", extendDays: 5 })).ok).toBe(true);
    expect((await entitlementOf(wsId)).state).toBe("active");
  });
});

describe("new workspaces", () => {
  it("start a 14-day trial on the Business plan", async () => {
    process.env.BILLING_ENFORCEMENT = "on";
    const u = await createUser("fresh@bill.test", "Fresh");
    await actAs(u.id);
    const res = await createWorkspace(fd({ name: "Fresh Shop" }));
    expect(res.ok).toBe(true);
    const ws = await prisma.workspace.findFirstOrThrow({ where: { name: "Fresh Shop" } });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { workspaceId: ws.id } });
    expect(sub.status).toBe("TRIALING");
    expect(sub.planKey).toBe("BUSINESS");
    const days = (sub.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
  });

  it("cannot take a slug that belongs to the app", async () => {
    const u = await createUser("slug@bill.test", "Slug");
    await actAs(u.id);
    await createWorkspace(fd({ name: "Admin" }));
    const ws = await prisma.workspace.findFirstOrThrow({
      where: { memberships: { some: { userId: u.id } } },
    });
    expect(ws.slug).not.toBe("admin");
    expect(ws.slug).toBe("admin-2");
  });
});
