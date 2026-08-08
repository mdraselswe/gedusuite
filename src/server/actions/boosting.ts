"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { InsufficientTreasury, assertTreasuryCovers } from "@/lib/finance";
import { ConcurrentWrite, runSerializable } from "@/lib/tx";
import { isOrderSource } from "@/lib/order-source";
import { failed, type ActionFailure } from "@/lib/form";
import { diffFields, recordActivity } from "@/lib/activity";

export type ActionResult =
  | { ok: true; id?: string }
  | ActionFailure;

const BOOST_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;

const CampaignSchema = z.object({
  name: z.string().trim().min(1, "Campaign name is required").max(120),
  objective: z.string().trim().max(120).optional().or(z.literal("")),
  // Which channel the ads run on, from ORDER_SOURCES — it's what an untagged
  // order is matched against when the campaign's result is estimated. Blank
  // is allowed and means "any channel".
  channel: z.string().trim().optional().or(z.literal("")),
  status: z.enum(BOOST_STATUSES),
  notes: z.string().trim().max(300).optional().or(z.literal("")),
});

const AdSetSchema = z.object({
  name: z.string().trim().min(1, "Ad set name is required").max(120),
  startDate: z.coerce.date(),
  endDate: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.date().optional(),
  ),
  dailyBudget: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().nonnegative().optional(),
  ),
  status: z.enum(BOOST_STATUSES),
  notes: z.string().trim().max(300).optional().or(z.literal("")),
});

const SpendSchema = z.object({
  date: z.coerce.date(),
  amount: z.coerce.number().positive("Amount must be > 0"),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  // Funding source is one of three mutually exclusive states — same model as
  // Purchase: nobody tracked / a partner's own money / the shared treasury.
  fundingSource: z.enum(["NONE", "PARTNER", "TREASURY"]).default("NONE"),
  paidByPartnerId: z.string().optional().or(z.literal("")),
});

function revalidateBoosting(slug: string, campaignId?: string) {
  revalidatePath(`/${slug}/boosting`);
  if (campaignId) revalidatePath(`/${slug}/boosting/${campaignId}`);
}

// Funded spends also move money in treasury/partner ledgers.
function revalidateFunding(slug: string) {
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/partners`);
  revalidatePath(`/${slug}/dashboard`);
}

// ── Campaigns ───────────────────────────────────────────────────────

export async function createCampaign(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "add");
  if (!gate.ok) return gate;

  const parsed = CampaignSchema.safeParse({
    name: formData.get("name"),
    objective: formData.get("objective") ?? undefined,
    channel: formData.get("channel") ?? undefined,
    status: formData.get("status") ?? "ACTIVE",
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  const campaign = await prisma.boostCampaign.create({
    data: {
      workspaceId: gate.access.workspaceId,
      name: d.name,
      objective: d.objective?.trim() || null,
      channel: isOrderSource(d.channel) ? d.channel : null,
      status: d.status,
      notes: d.notes?.trim() || null,
    },
  });

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "BoostCampaign",
    entityId: campaign.id,
    entityLabel: d.name,
    summary: `Campaign created — ${d.status.toLowerCase()}`,
  });

  revalidateBoosting(slug);
  return { ok: true, id: campaign.id };
}

export async function updateCampaign(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "edit");
  if (!gate.ok) return gate;

  const campaign = await prisma.boostCampaign.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: { id: true },
  });
  if (!campaign) return { ok: false, error: "Campaign not found" };

  const parsed = CampaignSchema.safeParse({
    name: formData.get("name"),
    objective: formData.get("objective") ?? undefined,
    channel: formData.get("channel") ?? undefined,
    status: formData.get("status") ?? "ACTIVE",
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  const before = await prisma.boostCampaign.findUnique({
    where: { id },
    select: { name: true, objective: true, channel: true, status: true, notes: true },
  });
  await prisma.boostCampaign.update({
    where: { id },
    data: {
      name: d.name,
      objective: d.objective?.trim() || null,
      channel: isOrderSource(d.channel) ? d.channel : null,
      status: d.status,
      notes: d.notes?.trim() || null,
    },
  });

  const campaignChanges = before
    ? diffFields(
        before,
        {
          name: d.name,
          objective: d.objective?.trim() || null,
          channel: isOrderSource(d.channel) ? d.channel : null,
          status: d.status,
          notes: d.notes?.trim() || null,
        },
        ["name", "objective", "channel", "status", "notes"],
      )
    : null;
  if (campaignChanges) {
    // The channel decides which untagged orders a campaign gets credit for,
    // so changing it rewrites the campaign's results after the fact.
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "BoostCampaign",
      entityId: id,
      entityLabel: d.name,
      summary: "Campaign edited",
      changes: campaignChanges,
    });
  }

  revalidateBoosting(slug, id);
  return { ok: true };
}

export async function deleteCampaign(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const campaign = await prisma.boostCampaign.findFirst({
    where: { id, workspaceId },
    select: { id: true, name: true },
  });
  if (!campaign) return { ok: false, error: "Campaign not found" };

  await prisma.$transaction(async (tx) => {
    // Treasury deductions for the campaign's spends must go explicitly — that
    // FK is ON DELETE SET NULL, so the cascade below would orphan them and the
    // money would stay deducted for spends that no longer exist. (The auto
    // INVESTMENT partner txns cascade on their own.)
    await tx.treasuryEntry.deleteMany({
      where: { workspaceId, boostSpend: { adSet: { campaignId: id } } },
    });
    // Cascades to ad sets and daily spends.
    await tx.boostCampaign.deleteMany({ where: { id, workspaceId } });
  });

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "BoostCampaign",
    entityId: id,
    entityLabel: campaign.name,
    summary: "Campaign deleted — its ad sets and every spend entry went with it",
  });

  revalidateBoosting(slug);
  revalidateFunding(slug);
  return { ok: true };
}

// ── Ad sets ─────────────────────────────────────────────────────────

export async function createAdSet(
  slug: string,
  campaignId: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "add");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const campaign = await prisma.boostCampaign.findFirst({
    where: { id: campaignId, workspaceId },
    select: { id: true },
  });
  if (!campaign) return { ok: false, error: "Campaign not found" };

  const parsed = AdSetSchema.safeParse({
    name: formData.get("name"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate") ?? undefined,
    dailyBudget: formData.get("dailyBudget") ?? undefined,
    status: formData.get("status") ?? "ACTIVE",
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;
  if (d.endDate && d.endDate < d.startDate) {
    return { ok: false, error: "End date can't be before start date" };
  }

  const adSet = await prisma.boostAdSet.create({
    data: {
      workspaceId,
      campaignId,
      name: d.name,
      startDate: d.startDate,
      endDate: d.endDate ?? null,
      dailyBudget: d.dailyBudget ?? null,
      status: d.status,
      notes: d.notes?.trim() || null,
    },
  });

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "BoostAdSet",
    entityId: adSet.id,
    entityLabel: d.name,
    summary: `Ad set created — from ${d.startDate.toISOString().slice(0, 10)}`,
  });

  revalidateBoosting(slug, campaignId);
  return { ok: true, id: adSet.id };
}

export async function updateAdSet(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "edit");
  if (!gate.ok) return gate;

  const adSet = await prisma.boostAdSet.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: {
      id: true,
      campaignId: true,
      name: true,
      startDate: true,
      endDate: true,
      status: true,
    },
  });
  if (!adSet) return { ok: false, error: "Ad set not found" };

  const parsed = AdSetSchema.safeParse({
    name: formData.get("name"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate") ?? undefined,
    dailyBudget: formData.get("dailyBudget") ?? undefined,
    status: formData.get("status") ?? "ACTIVE",
    notes: formData.get("notes") ?? undefined,
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;
  if (d.endDate && d.endDate < d.startDate) {
    return { ok: false, error: "End date can't be before start date" };
  }

  await prisma.boostAdSet.update({
    where: { id },
    data: {
      name: d.name,
      startDate: d.startDate,
      endDate: d.endDate ?? null,
      dailyBudget: d.dailyBudget ?? null,
      status: d.status,
      notes: d.notes?.trim() || null,
    },
  });

  // Ad set dates are the campaign's window, and the window decides which
  // untagged orders it gets credit for — an estimated result moves with them.
  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "BoostAdSet",
    entityId: id,
    entityLabel: d.name,
    summary: "Ad set edited",
    changes: diffFields(
      adSet,
      { name: d.name, startDate: d.startDate, endDate: d.endDate ?? null, status: d.status },
      ["name", "startDate", "endDate", "status"],
    ),
  });

  revalidateBoosting(slug, adSet.campaignId);
  return { ok: true };
}

export async function deleteAdSet(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const adSet = await prisma.boostAdSet.findFirst({
    where: { id, workspaceId },
    select: { id: true, campaignId: true, name: true },
  });
  if (!adSet) return { ok: false, error: "Ad set not found" };

  await prisma.$transaction(async (tx) => {
    // Same as deleteCampaign: clear the SET NULL treasury links before the
    // spend rows cascade away, or the deductions linger orphaned.
    await tx.treasuryEntry.deleteMany({
      where: { workspaceId, boostSpend: { adSetId: id } },
    });
    await tx.boostAdSet.deleteMany({ where: { id, workspaceId } });
  });

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "BoostAdSet",
    entityId: id,
    entityLabel: adSet.name,
    summary: "Ad set deleted — its spend entries went with it",
  });

  revalidateBoosting(slug, adSet.campaignId);
  revalidateFunding(slug);
  return { ok: true };
}

// ── Daily spends ────────────────────────────────────────────────────

export async function addDailySpend(
  slug: string,
  adSetId: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "add");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const adSet = await prisma.boostAdSet.findFirst({
    where: { id: adSetId, workspaceId },
    select: { id: true, campaignId: true, name: true, campaign: { select: { name: true } } },
  });
  if (!adSet) return { ok: false, error: "Ad set not found" };

  const parsed = SpendSchema.safeParse({
    date: formData.get("date"),
    amount: formData.get("amount"),
    note: formData.get("note") ?? undefined,
    fundingSource: formData.get("fundingSource") ?? "NONE",
    paidByPartnerId: formData.get("paidByPartnerId") ?? undefined,
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  if (d.fundingSource === "PARTNER" && !d.paidByPartnerId) {
    return { ok: false, error: "Select a partner" };
  }
  let paidByPartnerId: string | null = null;
  if (d.fundingSource === "PARTNER" && d.paidByPartnerId) {
    const partner = await prisma.partner.findFirst({
      where: { id: d.paidByPartnerId, workspaceId },
      select: { id: true },
    });
    if (!partner) return { ok: false, error: "Partner not found" };
    paidByPartnerId = partner.id;
  }
  const paidFromTreasury = d.fundingSource === "TREASURY";

  // Normalize to date-only so per-day grouping works regardless of what
  // time-of-day the input parsed to. No same-day uniqueness: Facebook charges
  // a card as many times per day as it hits billing thresholds.
  const day = new Date(d.date.toISOString().slice(0, 10));

  let spendId: string;
  try {
    spendId = await runSerializable(async (tx) => {
      // Inside the transaction: the balance is read and spent as one step.
      if (paidFromTreasury) await assertTreasuryCovers(tx, workspaceId, d.amount);
      const spend = await tx.boostDailySpend.create({
      data: {
        workspaceId,
        adSetId,
        date: day,
        amount: d.amount,
        note: d.note?.trim() || null,
        paidByPartnerId,
        paidFromTreasury,
      },
    });
    if (paidFromTreasury) {
      await tx.treasuryEntry.create({
        data: {
          workspaceId,
          type: "OUT",
          amount: d.amount,
          source: `Boosting: ${adSet.campaign.name} / ${adSet.name}`,
          boostSpendId: spend.id,
          date: day,
        },
      });
    }
    if (paidByPartnerId) {
      // Out-of-pocket spend is both sides of the ledger: the money entered the
      // business (INVESTMENT credit) and was spent on ads (the tagged spend).
      // Without the credit the partner's "remaining" would go negative.
      await tx.partnerTxn.create({
        data: {
          workspaceId,
          partnerId: paidByPartnerId,
          type: "INVESTMENT",
          amount: d.amount,
          purpose: `Boosting: ${adSet.campaign.name} / ${adSet.name}`,
          boostSpendId: spend.id,
          date: day,
        },
      });
    }
    return spend.id;
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "BoostDailySpend",
    entityId: spendId,
    entityLabel: adSet.name,
    summary: `৳${d.amount} ad spend on ${day.toISOString().slice(0, 10)} (${d.fundingSource.toLowerCase()})`,
  });

  revalidateBoosting(slug, adSet.campaignId);
  revalidateFunding(slug);
  return { ok: true };
}

export async function deleteDailySpend(slug: string, id: string): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "edit");
  if (!gate.ok) return gate;

  const workspaceId = gate.access.workspaceId;
  const spend = await prisma.boostDailySpend.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      amount: true,
      date: true,
      adSet: { select: { campaignId: true, name: true } },
    },
  });
  if (!spend) return { ok: false, error: "Spend entry not found" };

  await prisma.$transaction(async (tx) => {
    // Delete the linked treasury deduction first, if any — the FK is
    // ON DELETE SET NULL, which would otherwise leave a stray entry behind
    // still counting against the treasury balance.
    await tx.treasuryEntry.deleteMany({ where: { workspaceId, boostSpendId: id } });
    // The auto INVESTMENT credit cascades on delete, but remove it explicitly
    // so the intent is visible here rather than buried in the schema.
    await tx.partnerTxn.deleteMany({ where: { workspaceId, boostSpendId: id } });
    await tx.boostDailySpend.deleteMany({ where: { id, workspaceId } });
  });

  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "BoostDailySpend",
    entityId: id,
    entityLabel: spend.adSet.name,
    summary: `Deleted ৳${Number(spend.amount)} of ad spend from ${spend.date.toISOString().slice(0, 10)}`,
  });

  revalidateBoosting(slug, spend.adSet.campaignId);
  revalidateFunding(slug);
  return { ok: true };
}
