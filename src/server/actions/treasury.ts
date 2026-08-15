"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";
import { InsufficientTreasury, assertTreasuryCovers } from "@/lib/finance";
import { ConcurrentWrite, runSerializable } from "@/lib/tx";
import { failed, type ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";
import { dhakaDateField } from "@/lib/date-field";

export type ActionResult = { ok: true } | ActionFailure;

const EntrySchema = z.object({
  type: z.enum(["IN", "OUT"]),
  amount: z.coerce.number().positive("Amount must be > 0"),
  source: z.string().trim().min(1, "Source is required").max(120),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  partnerId: z.string().optional().or(z.literal("")),
  date: dhakaDateField,
});

export async function createTreasuryEntry(
  slug: string,
  formData: FormData,
): Promise<ActionResult> {
  // Adding to the treasury ledger is OWNER-level (treasury "full").
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const parsed = EntrySchema.safeParse({
    type: formData.get("type"),
    amount: formData.get("amount"),
    source: formData.get("source"),
    note: formData.get("note") ?? undefined,
    partnerId: formData.get("partnerId") ?? undefined,
    date: formData.get("date"),
  });
  if (!parsed.success) {
    return failed(parsed.error);
  }
  const d = parsed.data;

  let partnerId: string | null = null;
  if (d.partnerId) {
    const partner = await prisma.partner.findFirst({
      where: { id: d.partnerId, workspaceId },
      select: { id: true },
    });
    if (!partner) return { ok: false, error: "Partner not found" };
    partnerId = partner.id;
  }

  // A hand-entered OUT spends the treasury exactly as a purchase does, and was
  // the one path that never checked whether there was anything to spend. Every
  // other one — purchases, boost spends, partner withdrawals, distributions —
  // has refused to overdraw for a while; a 20,000 "Rent" against a balance of
  // 5,000 simply took the treasury to −15,000 and said nothing.
  let entryId: string;
  try {
    entryId = await runSerializable(async (tx) => {
      if (d.type === "OUT") await assertTreasuryCovers(tx, workspaceId, d.amount);
      const created = await tx.treasuryEntry.create({
        data: {
          workspaceId,
          type: d.type,
          amount: d.amount,
          source: d.source,
          note: d.note?.trim() || null,
          partnerId,
          date: d.date.at,
          dateHasTime: d.date.hasTime,
        },
      });
      return created.id;
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  await recordActivity(gate.access, {
    action: "CREATE",
    entity: "TreasuryEntry",
    entityId: entryId,
    entityLabel: d.source,
    summary:
      `৳${d.amount} ${d.type === "IN" ? "in" : "out"} — ${d.source}` +
      (d.note?.trim() ? ` (${d.note.trim()})` : ""),
  });

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}

export async function deleteTreasuryEntry(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "treasury", "full");
  if (!gate.ok) return gate;

  const entry = await prisma.treasuryEntry.findFirst({
    where: { id, workspaceId: gate.access.workspaceId },
    select: {
      type: true,
      amount: true,
      source: true,
      partnerTxnId: true,
      orderId: true,
      purchaseId: true,
      internalPurchaseId: true,
      distributionId: true,
      boostSpendId: true,
    },
  });
  if (!entry) return { ok: false, error: "Entry not found" };
  if (entry.distributionId) {
    return {
      ok: false,
      error: "This entry came from a profit distribution — delete the whole distribution instead",
    };
  }
  if (entry.partnerTxnId) {
    return {
      ok: false,
      error: "This entry came from a partner deposit — delete that transaction instead",
    };
  }
  if (entry.orderId) {
    return {
      ok: false,
      error: "This entry came from an order's cash deposit — unmark it from the order instead",
    };
  }
  if (entry.purchaseId) {
    return {
      ok: false,
      error: "This entry came from a treasury-funded purchase — change its funding source or delete the purchase instead",
    };
  }
  if (entry.internalPurchaseId) {
    return {
      ok: false,
      error: "This entry came from a treasury-funded internal purchase — change its funding source or delete the entry instead",
    };
  }
  if (entry.boostSpendId) {
    return {
      ok: false,
      error: "This entry came from a treasury-funded boost spend — delete that spend entry instead",
    };
  }

  // Taking an IN back out moves the balance exactly as spending does, and this
  // was the one path in the module that never checked. Delete a ৳20,000 "Sales
  // collection" after ৳15,000 has been spent against it and the treasury went
  // to −৳15,000 without a word — the state createTreasuryEntry, purchases,
  // boost spends, withdrawals and distributions all exist to prevent.
  //
  // Serializable and inside the transaction for the same reason the create
  // path is: two deletions at the same moment would otherwise both read a
  // balance that only covers one of them.
  try {
    await runSerializable(async (tx) => {
      if (entry.type === "IN") {
        await assertTreasuryCovers(tx, gate.access.workspaceId, Number(entry.amount));
      }
      await tx.treasuryEntry.delete({ where: { id } });
    });
  } catch (e) {
    if (e instanceof InsufficientTreasury || e instanceof ConcurrentWrite) {
      return { ok: false, error: e.message };
    }
    throw e;
  }

  // The balance moved and the row explaining it is gone, so this line is now
  // the only account of it.
  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "TreasuryEntry",
    entityId: id,
    entityLabel: entry.source,
    summary: `Deleted a ৳${Number(entry.amount)} ${entry.type === "IN" ? "in" : "out"} entry — ${entry.source}`,
  });

  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
