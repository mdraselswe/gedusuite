import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveWooConfig } from "@/lib/woo-config";
import {
  disconnectWebsite,
  getWebsiteIntegration,
  rotateWebsiteSecrets,
  saveWebsiteIntegration,
} from "@/server/actions/integrations";
import { POST as legacyWebhook } from "@/app/api/cron/woo-lead/route";
import { POST as workspaceWebhook } from "@/app/api/hooks/woo/[token]/route";
import {
  actAs,
  addMember,
  createUser,
  createWorkspaceWithOwner,
  fd,
  resetDatabase,
} from "./harness";

const ENV_KEYS = ["WOO_WORKSPACE_SLUG", "WOO_WEBHOOK_SECRET", "WC_CONSUMER_KEY", "WC_CONSUMER_SECRET", "WP_URL"] as const;
const saved: Record<string, string | undefined> = {};

const sign = (raw: string, secret: string) =>
  createHmac("sha256", secret).update(raw, "utf8").digest("base64");

const order = (id: number, phone: string) =>
  JSON.stringify({
    id,
    number: String(id),
    status: "processing",
    date_created_gmt: "2026-09-01T10:00:00",
    total: "1500.00",
    billing: { first_name: "Test", last_name: "Buyer", phone, address_1: "Road 1", city: "Dhaka" },
    line_items: [{ name: "Baby Lotion", quantity: 1 }],
  });

let a = { id: "", slug: "shop-a", owner: "" };
let b = { id: "", slug: "shop-b", owner: "" };
let manager = "";

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.WOO_WORKSPACE_SLUG = "shop-a";
  process.env.WOO_WEBHOOK_SECRET = "env-webhook-secret";
  process.env.WC_CONSUMER_KEY = "ck_env";
  process.env.WC_CONSUMER_SECRET = "cs_env";
  process.env.WP_URL = "https://env-shop.example.com";

  await resetDatabase();
  const ownerA = await createUser("a@woo.test", "Owner A");
  const ownerB = await createUser("b@woo.test", "Owner B");
  const mgr = await createUser("m@woo.test", "Manager");
  const wa = await createWorkspaceWithOwner("Shop A", a.slug, ownerA.id);
  const wb = await createWorkspaceWithOwner("Shop B", b.slug, ownerB.id);
  await addMember(wa.id, mgr.id, "MANAGER");
  a = { ...a, id: wa.id, owner: ownerA.id };
  b = { ...b, id: wb.id, owner: ownerB.id };
  manager = mgr.id;
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("which website a workspace talks to", () => {
  it("the original shop keeps using the environment, others get nothing", async () => {
    const forA = await resolveWooConfig(a.id);
    expect(forA?.source).toBe("env");
    expect(forA?.base).toBe("https://env-shop.example.com");
    expect(await resolveWooConfig(b.id)).toBeNull();
  });

  it("a deployment with no WOO_WORKSPACE_SLUG behaves as it always did (env for everyone)", async () => {
    delete process.env.WOO_WORKSPACE_SLUG;
    expect((await resolveWooConfig(b.id))?.source).toBe("env");
    process.env.WOO_WORKSPACE_SLUG = "shop-a";
  });

  it("only an owner can save a connection; secrets are stored encrypted", async () => {
    await actAs(manager);
    const denied = await saveWebsiteIntegration(
      a.slug,
      fd({ url: "https://m.example.com", consumerKey: "ck_x", consumerSecret: "cs_x" }),
    );
    expect(denied.ok).toBe(false);

    await actAs(b.owner);
    const saved = await saveWebsiteIntegration(
      b.slug,
      fd({ url: "shop-b.example.com", consumerKey: "ck_bbbb1234", consumerSecret: "cs_bbbb5678" }),
    );
    expect(saved.ok).toBe(true);

    const row = await prisma.workspaceIntegration.findUniqueOrThrow({ where: { workspaceId: b.id } });
    expect(row.wooUrl).toBe("https://shop-b.example.com");
    expect(row.wooConsumerKeyEnc).not.toContain("ck_bbbb1234");
    expect(row.hookToken).toMatch(/^[0-9a-f]{32}$/);

    const cfg = await resolveWooConfig(b.id);
    expect(cfg).toMatchObject({
      source: "workspace",
      base: "https://shop-b.example.com",
      readKey: "ck_bbbb1234",
      readSecret: "cs_bbbb5678",
    });

    const state = await getWebsiteIntegration(b.slug);
    expect("ok" in state).toBe(false);
    if (!("ok" in state)) {
      expect(state.consumerKeyHint).toBe("…1234");
      expect(state.orderWebhookUrl).toContain(`/api/hooks/woo/${row.hookToken}`);
    }
  });

  it("editing the address without re-typing keys keeps the stored keys", async () => {
    await actAs(b.owner);
    const res = await saveWebsiteIntegration(b.slug, fd({ url: "https://shop-b2.example.com" }));
    expect(res.ok).toBe(true);
    const cfg = await resolveWooConfig(b.id);
    expect(cfg?.base).toBe("https://shop-b2.example.com");
    expect(cfg?.readKey).toBe("ck_bbbb1234");
  });
});

describe("order webhooks", () => {
  it("the original env-based route still works exactly as before", async () => {
    const raw = order(5001, "01711111111");
    const res = await legacyWebhook(
      new NextRequest("http://localhost/api/cron/woo-lead", {
        method: "POST",
        body: raw,
        headers: { "x-wc-webhook-signature": sign(raw, "env-webhook-secret") },
      }),
    );
    expect(res.status).toBe(200);
    const leads = await prisma.orderLead.findMany({ where: { workspaceId: a.id } });
    expect(leads.map((l) => l.externalId)).toContain("5001");
  });

  it("a workspace's own webhook lands in that workspace only, with its own secret", async () => {
    const row = await prisma.workspaceIntegration.findUniqueOrThrow({ where: { workspaceId: b.id } });
    const { decrypt } = await import("@/lib/crypto");
    const secret = decrypt(row.wooWebhookSecretEnc!)!;

    const raw = order(7001, "01822222222");
    const call = (token: string, sig: string, body = raw) =>
      workspaceWebhook(
        new NextRequest(`http://localhost/api/hooks/woo/${token}`, {
          method: "POST",
          body,
          headers: { "x-wc-webhook-signature": sig },
        }),
        { params: Promise.resolve({ token }) },
      );

    expect((await call(row.hookToken!, "bad")).status).toBe(401);
    expect((await call("0".repeat(32), sign(raw, secret))).status).toBe(404);
    // an unsigned WooCommerce ping is answered, so saving the webhook works
    expect((await call(row.hookToken!, "", "webhook_id=12")).status).toBe(200);

    expect((await call(row.hookToken!, sign(raw, secret))).status).toBe(200);
    const inB = await prisma.orderLead.findMany({ where: { workspaceId: b.id } });
    expect(inB.map((l) => l.externalId)).toEqual(["7001"]);
    const inA = await prisma.orderLead.findMany({ where: { workspaceId: a.id } });
    expect(inA.map((l) => l.externalId)).not.toContain("7001");
  });

  it("regenerating invalidates the old address and secret at once", async () => {
    const before = await prisma.workspaceIntegration.findUniqueOrThrow({ where: { workspaceId: b.id } });
    await actAs(b.owner);
    expect((await rotateWebsiteSecrets(b.slug)).ok).toBe(true);
    const after = await prisma.workspaceIntegration.findUniqueOrThrow({ where: { workspaceId: b.id } });
    expect(after.hookToken).not.toBe(before.hookToken);

    const raw = order(7002, "01833333333");
    const res = await workspaceWebhook(
      new NextRequest(`http://localhost/api/hooks/woo/${before.hookToken}`, {
        method: "POST",
        body: raw,
      }),
      { params: Promise.resolve({ token: before.hookToken! }) },
    );
    expect(res.status).toBe(404);
  });

  it("disconnecting removes the connection", async () => {
    await actAs(b.owner);
    expect((await disconnectWebsite(b.slug)).ok).toBe(true);
    expect(await resolveWooConfig(b.id)).toBeNull();
  });
});
