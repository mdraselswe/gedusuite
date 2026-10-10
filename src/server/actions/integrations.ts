"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { decrypt, encrypt } from "@/lib/crypto";
import { recordActivity } from "@/lib/activity";
import { failed, type ActionFailure } from "@/lib/form";
import { appUrl } from "@/lib/mailer";
import { resolveWooConfig, keyHint } from "@/lib/woo-config";
import { wooFetch } from "@/lib/woo-catalog";

/**
 * A workspace's connection to its own WooCommerce website.
 *
 * Owner-only (the "team" module is OWNER-full): the keys here can read every
 * order the shop has taken and edit its catalogue.
 */
const MODULE = "team" as const;

export type ActionResult = { ok: true } | ActionFailure;

export type WebsiteIntegrationState = {
  /** Where the effective connection comes from. */
  source: "workspace" | "environment" | "none";
  url: string | null;
  consumerKeyHint: string | null;
  writeKeyHint: string | null;
  /** Both are shown in full: they have to be copied into WooCommerce. */
  orderWebhookUrl: string | null;
  cartBeaconUrl: string | null;
  webhookSecret: string | null;
  cartBeaconSecret: string | null;
};

const newToken = () => randomBytes(16).toString("hex");
const newSecret = () => randomBytes(32).toString("hex");

export async function getWebsiteIntegration(slug: string): Promise<WebsiteIntegrationState | ActionFailure> {
  const gate = await requireAccess(slug, MODULE, "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const row = await prisma.workspaceIntegration.findUnique({ where: { workspaceId } });
  const effective = await resolveWooConfig(workspaceId);

  const base = appUrl();
  return {
    source: row?.wooUrl && effective?.source === "workspace" ? "workspace" : effective ? "environment" : "none",
    url: row?.wooUrl ?? (effective?.source === "env" ? effective.base : null),
    consumerKeyHint: keyHint(row?.wooConsumerKeyEnc),
    writeKeyHint: keyHint(row?.wooWriteKeyEnc),
    orderWebhookUrl: row?.hookToken ? `${base}/api/hooks/woo/${row.hookToken}` : null,
    cartBeaconUrl: row?.hookToken ? `${base}/api/hooks/cart/${row.hookToken}` : null,
    webhookSecret: row?.wooWebhookSecretEnc ? decrypt(row.wooWebhookSecretEnc) : null,
    cartBeaconSecret: row?.cartBeaconSecretEnc ? decrypt(row.cartBeaconSecretEnc) : null,
  };
}

const SaveSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Website address is required")
    .transform((v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`))
    .pipe(z.string().url("Enter a valid website address"))
    .transform((v) => v.replace(/\/+$/, "")),
  consumerKey: z.string().trim().max(200).optional().or(z.literal("")),
  consumerSecret: z.string().trim().max(200).optional().or(z.literal("")),
  writeKey: z.string().trim().max(200).optional().or(z.literal("")),
  writeSecret: z.string().trim().max(200).optional().or(z.literal("")),
});

/**
 * Save the website address and keys. A key left blank keeps what is stored, so
 * editing the address does not mean pasting every secret again — the form
 * never has them to show.
 */
export async function saveWebsiteIntegration(slug: string, formData: FormData): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = SaveSchema.safeParse({
    url: formData.get("url"),
    consumerKey: formData.get("consumerKey") ?? undefined,
    consumerSecret: formData.get("consumerSecret") ?? undefined,
    writeKey: formData.get("writeKey") ?? undefined,
    writeSecret: formData.get("writeSecret") ?? undefined,
  });
  if (!parsed.success) return failed(parsed.error);
  const d = parsed.data;

  if (!/^https:\/\//i.test(d.url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(d.url)) {
    return { ok: false, error: "The website address must start with https://" };
  }
  if ((d.consumerKey && !d.consumerSecret) || (!d.consumerKey && d.consumerSecret)) {
    return { ok: false, error: "Enter both the consumer key and the consumer secret" };
  }
  if ((d.writeKey && !d.writeSecret) || (!d.writeKey && d.writeSecret)) {
    return { ok: false, error: "Enter both the write key and the write secret" };
  }

  const existing = await prisma.workspaceIntegration.findUnique({ where: { workspaceId } });
  const hasKeys =
    Boolean(d.consumerKey || existing?.wooConsumerKeyEnc) ||
    Boolean(d.writeKey || existing?.wooWriteKeyEnc);
  if (!hasKeys) {
    return { ok: false, error: "Enter the WooCommerce API key and secret for this website" };
  }

  const data = {
    wooUrl: d.url,
    ...(d.consumerKey
      ? { wooConsumerKeyEnc: encrypt(d.consumerKey), wooConsumerSecretEnc: encrypt(d.consumerSecret!) }
      : {}),
    ...(d.writeKey
      ? { wooWriteKeyEnc: encrypt(d.writeKey), wooWriteSecretEnc: encrypt(d.writeSecret!) }
      : {}),
  };
  await prisma.workspaceIntegration.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      ...data,
      hookToken: newToken(),
      wooWebhookSecretEnc: encrypt(newSecret()),
      cartBeaconSecretEnc: encrypt(newSecret()),
    },
    update: data,
  });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Workspace",
    entityId: workspaceId,
    entityLabel: "Website connection",
    // Never the keys themselves.
    summary: `Website connection saved for ${d.url}`,
  });

  revalidatePath(`/${slug}/settings/website`);
  return { ok: true };
}

/** Ask the website something harmless, to prove the address and keys work. */
export async function testWebsiteConnection(slug: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "full");
  if (!gate.ok) return gate;
  const cfg = await resolveWooConfig(gate.access.workspaceId);
  if (!cfg) return { ok: false, error: "No website connection is saved yet" };
  try {
    await wooFetch<unknown>("/products?per_page=1", undefined, cfg);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not reach the website",
    };
  }
}

/** New webhook address and secrets. The old ones stop working at once. */
export async function rotateWebsiteSecrets(slug: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const existing = await prisma.workspaceIntegration.findUnique({ where: { workspaceId } });
  if (!existing) return { ok: false, error: "Save the website connection first" };

  await prisma.workspaceIntegration.update({
    where: { workspaceId },
    data: {
      hookToken: newToken(),
      wooWebhookSecretEnc: encrypt(newSecret()),
      cartBeaconSecretEnc: encrypt(newSecret()),
    },
  });
  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Workspace",
    entityId: workspaceId,
    entityLabel: "Website connection",
    summary: "Webhook address and secrets were regenerated",
  });
  revalidatePath(`/${slug}/settings/website`);
  return { ok: true };
}

/** Forget the connection (keys, webhook secrets). Leads already imported stay. */
export async function disconnectWebsite(slug: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, MODULE, "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  await prisma.workspaceIntegration.deleteMany({ where: { workspaceId } });
  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "Workspace",
    entityId: workspaceId,
    entityLabel: "Website connection",
    summary: "Website connection removed",
  });
  revalidatePath(`/${slug}/settings/website`);
  return { ok: true };
}
