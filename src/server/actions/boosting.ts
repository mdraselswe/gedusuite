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
import { dhakaDateField } from "@/lib/date-field";
import { removePartnerCredit, syncPartnerCredit } from "@/lib/partner-credit";
import {
  AD_FUNDING_SOURCES,
  creditedPartnerId,
  fundingNeedsPartner,
  resolveFunding,
} from "@/lib/funding";

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
  date: dhakaDateField,
  amount: z.coerce.number().positive("Amount must be > 0"),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  // Same model as Purchase, less CREDIT — a platform charges the card as the
  // ads run, so ad spend is never bought on account. See lib/funding.ts.
  fundingSource: z.enum(AD_FUNDING_SOURCES).default("NONE"),
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

/**
 * Turn the form's funding choice into the columns, having checked the partner
 * belongs to this workspace. Shared by add and update so the two can't drift —
 * an id from a form is not a partner until the database says so, and a foreign
 * key alone would happily accept one from another workspace.
 */
async function resolveSpendFunding(
  workspaceId: string,
  d: z.infer<typeof SpendSchema>,
): Promise<
  | { ok: true; paidByPartnerId: string | null; paidFromTreasury: boolean; creditTo: string | null }
  | ActionFailure
> {
  const needsPartner = fundingNeedsPartner(d.fundingSource);
  if (needsPartner && !d.paidByPartnerId) {
    return { ok: false, error: "Select a partner" };
  }
  let namedPartnerId: string | null = null;
  if (needsPartner && d.paidByPartnerId) {
    const partner = await prisma.partner.findFirst({
      where: { id: d.paidByPartnerId, workspaceId },
      select: { id: true },
    });
    if (!partner) return { ok: false, error: "Partner not found" };
    namedPartnerId = partner.id;
  }
  const flags = resolveFunding(d.fundingSource, namedPartnerId);
  return {
    ok: true,
    paidByPartnerId: flags.paidByPartnerId,
    paidFromTreasury: flags.paidFromTreasury,
    // Nobody on a reimbursed row: the partner's name records who fronted the
    // card, but the treasury is what paid, so no capital of theirs went in.
    creditTo: creditedPartnerId(flags),
  };
}

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

  const funding = await resolveSpendFunding(workspaceId, d);
  if (!funding.ok) return funding;
  const { paidByPartnerId, paidFromTreasury, creditTo } = funding;

  // Stored as the moment it was entered for, not flattened to a day. Per-day
  // grouping reads the Dhaka day off the timestamp (lib/dhaka-time), so cutting
  // the time off here bought nothing and moved an entry made after midnight to
  // the day before. No same-day uniqueness either way: Facebook charges a card
  // as many times per day as it hits billing thresholds.
  const day = d.date.at;
  const dateHasTime = d.date.hasTime;

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
        dateHasTime,
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
          dateHasTime,
        },
      });
    }
    if (creditTo) {
      // Out-of-pocket spend is both sides of the ledger: the money entered the
      // business (INVESTMENT credit) and was spent on ads (the tagged spend).
      // Without the credit the partner's "remaining" would go negative.
      await syncPartnerCredit(tx, {
        workspaceId,
        link: { boostSpendId: spend.id },
        partnerId: creditTo,
        amount: d.amount,
        purpose: `Boosting: ${adSet.campaign.name} / ${adSet.name}`,
        date: day,
        dateHasTime,
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

/**
 * Correct a day's ad spend — the amount, the date, or who paid for it.
 *
 * This module had create and delete and nothing between them, which was fine
 * while funding was a fact you knew at entry time. It isn't: a partner puts the
 * ads on their own card and the treasury pays them back days later, and until
 * now the only way to record that second half was to delete the row and type it
 * again, or to write a hand-made withdrawal — which is what quietly drove a
 * reimbursing partner's capital negative (see lib/funding.ts).
 *
 * The treasury and credit bookkeeping is `updatePurchase`'s, because the four
 * cases are the same four: becoming treasury-funded, ceasing to be, staying so
 * at a new amount, and never having been.
 */
export async function updateDailySpend(
  slug: string,
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "boosting", "edit");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const existing = await prisma.boostDailySpend.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      amount: true,
      date: true,
      dateHasTime: true,
      note: true,
      paidByPartnerId: true,
      paidFromTreasury: true,
      treasuryEntry: { select: { id: true, amount: true } },
      adSet: { select: { id: true, name: true, campaignId: true, campaign: { select: { name: true } } } },
    },
  });
  if (!existing) return { ok: false, error: "Spend entry not found" };

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

  const funding = await resolveSpendFunding(workspaceId, d);
  if (!funding.ok) return funding;
  const { paidByPartnerId, paidFromTreasury, creditTo } = funding;

  const label = `Boosting: ${existing.adSet.campaign.name} / ${existing.adSet.name}`;
  const wasTreasuryFunded = existing.paidFromTreasury;
  const oldEntryAmount = existing.treasuryEntry ? Number(existing.treasuryEntry.amount) : 0;
  const day = d.date.at;
  const dateHasTime = d.date.hasTime;

  try {
    await runSerializable(async (tx) => {
      // The old entry's amount is credited back: it is being replaced, not
      // spent a second time.
      if (paidFromTreasury) {
        await assertTreasuryCovers(
          tx,
          workspaceId,
          d.amount,
          wasTreasuryFunded ? oldEntryAmount : 0,
        );
      }
      await tx.boostDailySpend.update({
        where: { id },
        data: {
          date: day,
          dateHasTime,
          amount: d.amount,
          note: d.note?.trim() || null,
          paidByPartnerId,
          paidFromTreasury,
        },
      });

      if (wasTreasuryFunded && !paidFromTreasury) {
        await tx.treasuryEntry.deleteMany({ where: { workspaceId, boostSpendId: id } });
      } else if (!wasTreasuryFunded && paidFromTreasury) {
        await tx.treasuryEntry.create({
          data: {
            workspaceId,
            type: "OUT",
            amount: d.amount,
            source: label,
            boostSpendId: id,
            date: day,
            dateHasTime,
          },
        });
      } else if (wasTreasuryFunded && paidFromTreasury && existing.treasuryEntry) {
        await tx.treasuryEntry.update({
          where: { id: existing.treasuryEntry.id },
          data: { amount: d.amount, source: label, date: day, dateHasTime },
        });
      }

      // Unconditional, like the purchase forms: one call covers becoming
      // partner-funded, ceasing to be, switching partner, becoming reimbursed
      // — which is the case that has to REMOVE the credit — and a plain
      // amount change.
      await syncPartnerCredit(tx, {
        workspaceId,
        link: { boostSpendId: id },
        partnerId: creditTo,
        amount: d.amount,
        purpose: label,
        date: day,
        dateHasTime,
      });
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  const changes = diffFields(
    {
      amount: Number(existing.amount),
      date: existing.date,
      note: existing.note,
      paidByPartnerId: existing.paidByPartnerId,
      paidFromTreasury: existing.paidFromTreasury,
    },
    {
      amount: d.amount,
      // `.at`, not the parsed field: diffFields normalises a Date, and handing
      // it the {at, hasTime} wrapper instead compares a date string against an
      // object, so every save would report the date as changed.
      date: d.date.at,
      note: d.note?.trim() || null,
      paidByPartnerId,
      paidFromTreasury,
    },
    ["amount", "date", "note", "paidByPartnerId", "paidFromTreasury"],
  );
  if (changes) {
    await recordActivity(gate.access, {
      action: "UPDATE",
      entity: "BoostDailySpend",
      entityId: id,
      entityLabel: existing.adSet.name,
      // Who paid is the field most likely to be corrected after the fact, so
      // the line says what it became rather than only that something moved.
      summary: `Ad spend edited — ৳${d.amount}, ${d.fundingSource.toLowerCase()}`,
      changes,
    });
  }

  revalidateBoosting(slug, existing.adSet.campaignId);
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
    await removePartnerCredit(tx, workspaceId, { boostSpendId: id });
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
