"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { failed, type ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";
import { MAX_BANDS, parseBands, parseOverrides, parseTiers, tierLabel, tiersForBands } from "@/lib/reseller-pricing";
import { loadResellerSettings } from "@/lib/reseller-list";
import {
  parseViewers,
  persistResellerTokens,
  queueResellerSync,
  resellerGoogleClient,
  syncResellerSheet,
} from "@/lib/reseller-sync";
import { addSheetViewer, removeSheetViewer, setSheetPublic, sheetUrl } from "@/lib/reseller-sheet";
import { variantFullName } from "@/lib/variants";

export type ActionResult<T = unknown> = ({ ok: true } & T) | ActionFailure;

const page = (slug: string) => `/${slug}/products/reseller`;

/**
 * The reseller list shows cost and profit, so it needs what the reports need on
 * top of the products module: someone who can't see the business's margins
 * can't see them here either.
 */
async function gate(slug: string, need: "view" | "edit") {
  const g = await requireAccess(slug, "products", need);
  if (!g.ok) return g;
  if (!can(g.access.role, "reports", "view", g.access.permissions)) {
    return { ok: false as const, error: "You do not have permission to do that" };
  }
  return g;
}

function googleMessage(e: unknown): string {
  const err = e as { message?: string; response?: { data?: { error?: { message?: string } } } };
  return err.response?.data?.error?.message ?? err.message ?? "Unknown error";
}

// ── Pricing rules ────────────────────────────────────────────────────

const SettingsSchema = z.object({
  title: z.string().trim().min(1, "Give the list a name").max(120),
  notes: z.string().max(4000).optional().default(""),
  minMarginPct: z.coerce.number().min(0, "Minimum margin can't be negative").max(1000),
  roundTo: z.coerce.number().int().min(1).max(1000),
  tiers: z
    .array(
      z.object({
        minQty: z.coerce.number().int().min(1, "Quantities start at 1").max(100000),
        discountPct: z.coerce.number().min(0, "Discount can't be negative").max(90, "Discount must be under 90%"),
      }),
    )
    .min(1, "Add at least one quantity band")
    .max(8, "At most 8 quantity bands"),
});

export async function saveResellerSettings(
  slug: string,
  input: z.input<typeof SettingsSchema>,
): Promise<ActionResult> {
  const g = await gate(slug, "edit");
  if (!g.ok) return g;
  const parsed = SettingsSchema.safeParse(input);
  if (!parsed.success) return failed(parsed.error);
  const d = parsed.data;
  const qtys = d.tiers.map((t) => t.minQty);
  if (new Set(qtys).size !== qtys.length) return { ok: false, error: "Two bands start at the same quantity" };
  const tiers = parseTiers(d.tiers);

  const workspaceId = g.access.workspaceId;
  const data = {
    title: d.title,
    notes: d.notes.trim() || null,
    minMarginPct: d.minMarginPct,
    roundTo: d.roundTo,
    tiers,
  };
  const saved = await prisma.resellerPriceList.upsert({
    where: { workspaceId },
    create: { workspaceId, ...data },
    update: data,
  });
  await recordActivity(g.access, {
    action: "UPDATE",
    entity: "ResellerPriceList",
    entityId: saved.id,
    entityLabel: d.title,
    summary: `Reseller pricing set: ${tiers.map((t) => `${t.minQty}+ pcs −${t.discountPct}%`).join(", ")}; minimum margin ${d.minMarginPct}%`,
  });
  queueResellerSync(workspaceId);
  revalidatePath(page(slug));
  return { ok: true };
}

const VariantPriceSchema = z.object({
  hidden: z.boolean(),
  prices: z.record(z.string(), z.union([z.number().nonnegative().max(1_000_000_000), z.null()])),
  /** Its own bands, as the quantity each starts at; null or absent for the list's. */
  bands: z
    .array(z.number().int().min(1, "Quantities start at 1").max(100000))
    .max(MAX_BANDS, `At most ${MAX_BANDS} quantity bands`)
    .nullable()
    .optional(),
});

/** One variant's exceptions: kept off the list, its own bands, hand-set band prices. */
export async function saveVariantResellerPrice(
  slug: string,
  variantId: string,
  input: z.input<typeof VariantPriceSchema>,
): Promise<ActionResult> {
  const g = await gate(slug, "edit");
  if (!g.ok) return g;
  const parsed = VariantPriceSchema.safeParse(input);
  if (!parsed.success) return failed(parsed.error);
  const workspaceId = g.access.workspaceId;

  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, product: { workspaceId } },
    select: { id: true, attributes: true, product: { select: { name: true } } },
  });
  if (!variant) return { ok: false, error: "Variant not found" };

  const raw = parsed.data.bands ?? null;
  if (raw && new Set(raw).size !== raw.length) return { ok: false, error: "Two bands start at the same quantity" };
  const bands = parseBands(raw);
  const tiers = tiersForBands((await loadResellerSettings(workspaceId)).tiers, bands);
  // A price for a band this variant no longer has would only resurface,
  // unasked, if the band came back.
  const prices = Object.fromEntries(
    Object.entries(parseOverrides(parsed.data.prices)).filter(([q]) => tiers.some((t) => t.minQty === Number(q))),
  );
  const data = { hidden: parsed.data.hidden, prices, bands: bands ?? Prisma.DbNull };
  const saved = await prisma.resellerVariantPrice.upsert({
    where: { productVariantId: variantId },
    create: { workspaceId, productVariantId: variantId, ...data },
    update: data,
  });
  const set = tiers
    .map((t, i) => (prices[t.minQty] != null ? `${tierLabel(tiers, i)} ৳${prices[t.minQty]}` : null))
    .filter(Boolean);
  const bandNote = bands ? `Own bands: ${tiers.map((_, i) => tierLabel(tiers, i)).join(", ")}. ` : "";
  await recordActivity(g.access, {
    action: "UPDATE",
    entity: "ResellerVariantPrice",
    entityId: saved.id,
    entityLabel: variantFullName(variant.product.name, variant.attributes),
    summary: parsed.data.hidden
      ? "Taken off the reseller list"
      : bandNote +
        (set.length ? `Reseller prices set by hand: ${set.join(", ")}` : "Reseller prices calculated"),
  });
  queueResellerSync(workspaceId);
  revalidatePath(page(slug));
  return { ok: true };
}

// ── Google Sheet ─────────────────────────────────────────────────────

/** Create the sheet if there is none, then bring it up to date. */
export async function syncResellerNow(slug: string): Promise<ActionResult<{ url: string | null; queued: boolean }>> {
  const g = await gate(slug, "edit");
  if (!g.ok) return g;
  const workspaceId = g.access.workspaceId;
  const hadSheet = await prisma.resellerPriceList.findUnique({ where: { workspaceId }, select: { sheetId: true } });
  const res = await syncResellerSheet(workspaceId, { create: true });
  if (!res.ok) {
    revalidatePath(page(slug));
    return res;
  }
  const list = await prisma.resellerPriceList.findUnique({ where: { workspaceId }, select: { id: true, sheetId: true } });
  if (!hadSheet?.sheetId && list?.sheetId) {
    await recordActivity(g.access, {
      action: "CREATE",
      entity: "ResellerPriceList",
      entityId: list.id,
      summary: "Reseller Google Sheet created",
    });
  }
  revalidatePath(page(slug));
  return { ok: true, url: list?.sheetId ? sheetUrl(list.sheetId) : null, queued: !!res.queued };
}

const EmailSchema = z.string().trim().toLowerCase().email("Enter a valid email");

async function connectedList(workspaceId: string) {
  const list = await prisma.resellerPriceList.findUnique({ where: { workspaceId } });
  const client = list && resellerGoogleClient(list);
  return list && client ? { list, client } : null;
}

/** Give a reseller view-only access to the sheet. */
export async function addResellerViewer(slug: string, rawEmail: string): Promise<ActionResult> {
  const g = await gate(slug, "edit");
  if (!g.ok) return g;
  const parsed = EmailSchema.safeParse(rawEmail);
  if (!parsed.success) return failed(parsed.error);
  const email = parsed.data;
  const workspaceId = g.access.workspaceId;
  const c = await connectedList(workspaceId);
  if (!c) return { ok: false, error: "Connect a Google account first" };

  const viewers = parseViewers(c.list.viewers);
  if (viewers.includes(email)) return { ok: false, error: `${email} can already see the sheet` };
  if (c.list.googleEmail && c.list.googleEmail.toLowerCase() === email) {
    return { ok: false, error: "That is the account the sheet belongs to" };
  }
  if (c.list.sheetId) {
    try {
      await addSheetViewer(c.client, c.list.sheetId, email);
      await persistResellerTokens(workspaceId, c.client);
    } catch (e) {
      return { ok: false, error: `Google refused to share with ${email}: ${googleMessage(e)}` };
    }
  }
  await prisma.resellerPriceList.update({ where: { workspaceId }, data: { viewers: [...viewers, email] } });
  await recordActivity(g.access, {
    action: "UPDATE",
    entity: "ResellerPriceList",
    entityId: c.list.id,
    summary: `Reseller sheet shared with ${email} (view only)`,
  });
  revalidatePath(page(slug));
  return { ok: true };
}

export async function removeResellerViewer(slug: string, email: string): Promise<ActionResult> {
  const g = await gate(slug, "edit");
  if (!g.ok) return g;
  const workspaceId = g.access.workspaceId;
  const c = await connectedList(workspaceId);
  if (!c) return { ok: false, error: "Connect a Google account first" };
  const viewers = parseViewers(c.list.viewers);
  if (c.list.sheetId) {
    try {
      await removeSheetViewer(c.client, c.list.sheetId, email);
      await persistResellerTokens(workspaceId, c.client);
    } catch (e) {
      return { ok: false, error: `Google refused: ${googleMessage(e)}` };
    }
  }
  await prisma.resellerPriceList.update({
    where: { workspaceId },
    data: { viewers: viewers.filter((v) => v !== email) },
  });
  await recordActivity(g.access, {
    action: "UPDATE",
    entity: "ResellerPriceList",
    entityId: c.list.id,
    summary: `Reseller sheet no longer shared with ${email}`,
  });
  revalidatePath(page(slug));
  return { ok: true };
}

/** Anyone with the link can view — or back to only the people on the list. */
export async function setResellerPublic(slug: string, on: boolean): Promise<ActionResult> {
  const g = await gate(slug, "edit");
  if (!g.ok) return g;
  const workspaceId = g.access.workspaceId;
  const c = await connectedList(workspaceId);
  if (!c) return { ok: false, error: "Connect a Google account first" };
  if (c.list.sheetId) {
    try {
      await setSheetPublic(c.client, c.list.sheetId, on);
      await persistResellerTokens(workspaceId, c.client);
    } catch (e) {
      return { ok: false, error: `Google refused: ${googleMessage(e)}` };
    }
  }
  await prisma.resellerPriceList.update({ where: { workspaceId }, data: { publicLink: on } });
  await recordActivity(g.access, {
    action: "UPDATE",
    entity: "ResellerPriceList",
    entityId: c.list.id,
    summary: on ? "Reseller sheet opened to anyone with the link" : "Reseller sheet limited to invited resellers",
  });
  revalidatePath(page(slug));
  return { ok: true };
}

/**
 * Forget the Google account. The sheet stays in that Drive, and connecting the
 * same account again picks it back up.
 *
 * The tokens are dropped, not revoked: Google revokes a grant per account and
 * app, so revoking here would also cut off a personal backup that happens to
 * use the same account.
 */
export async function disconnectResellerGoogle(slug: string): Promise<ActionResult> {
  const g = await gate(slug, "edit");
  if (!g.ok) return g;
  const workspaceId = g.access.workspaceId;
  const list = await prisma.resellerPriceList.findUnique({ where: { workspaceId } });
  if (!list?.googleAccessToken) return { ok: true };
  await prisma.resellerPriceList.update({
    where: { workspaceId },
    data: { googleAccessToken: null, googleRefreshToken: null, googleExpiryDate: null, syncLockedUntil: null },
  });
  await recordActivity(g.access, {
    action: "UPDATE",
    entity: "ResellerPriceList",
    entityId: list.id,
    summary: `Google account ${list.googleEmail ?? ""} disconnected from the reseller sheet`.replace("  ", " "),
  });
  revalidatePath(page(slug));
  return { ok: true };
}
