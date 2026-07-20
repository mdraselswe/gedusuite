"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

const EntrySchema = z.object({
  type: z.enum(["IN", "OUT"]),
  amount: z.coerce.number().positive("Amount must be > 0"),
  source: z.string().trim().min(1, "Source is required").max(120),
  note: z.string().trim().max(300).optional().or(z.literal("")),
  partnerId: z.string().optional().or(z.literal("")),
  date: z.coerce.date(),
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
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
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

  await prisma.treasuryEntry.create({
    data: {
      workspaceId,
      type: d.type,
      amount: d.amount,
      source: d.source,
      note: d.note?.trim() || null,
      partnerId,
      date: d.date,
    },
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
    select: { partnerTxnId: true, orderId: true },
  });
  if (!entry) return { ok: false, error: "Entry not found" };
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

  await prisma.treasuryEntry.delete({ where: { id } });
  revalidatePath(`/${slug}/treasury`);
  revalidatePath(`/${slug}/dashboard`);
  return { ok: true };
}
