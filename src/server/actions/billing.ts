"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { failed, type ActionFailure } from "@/lib/form";
import { createInvoice, submitPayment } from "@/lib/billing-admin";
import { recordActivity } from "@/lib/activity";
import { PLANS, isPlanKey } from "@/lib/plans";

/**
 * The owner's side of billing. Uses workspaceAccess rather than requireAccess
 * on purpose: requireAccess blocks writes on a lapsed workspace, and paying is
 * exactly what a lapsed workspace must still be able to do.
 */
export type ActionResult = { ok: true } | ActionFailure;

async function ownerGate(slug: string) {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false as const, error: "Workspace not found or access denied" };
  if (!can(access.role, "team", "full", access.permissions)) {
    return { ok: false as const, error: "Only the workspace owner can manage billing" };
  }
  return { ok: true as const, access };
}

const ChoiceSchema = z.object({
  plan: z.string(),
  cycle: z.enum(["MONTHLY", "YEARLY"]),
});

/** Choose a plan; returns the payment request to pay against. */
export async function startCheckout(
  slug: string,
  formData: FormData,
): Promise<{ ok: true; invoiceId: string } | ActionFailure> {
  const gate = await ownerGate(slug);
  if (!gate.ok) return gate;
  const parsed = ChoiceSchema.safeParse({
    plan: formData.get("plan"),
    cycle: formData.get("cycle"),
  });
  if (!parsed.success) return failed(parsed.error);
  if (!isPlanKey(parsed.data.plan) || !PLANS[parsed.data.plan].sellable) {
    return { ok: false, error: "That plan is not available" };
  }
  const res = await createInvoice(gate.access.workspaceId, parsed.data.plan, parsed.data.cycle);
  if (!res.ok) return res;
  revalidatePath(`/${slug}/settings/billing`);
  return { ok: true, invoiceId: res.invoiceId };
}

const PaySchema = z.object({
  invoiceId: z.string().min(1),
  method: z.string().min(1),
  senderNumber: z.string().trim().max(20).optional().or(z.literal("")),
  trxId: z.string().min(1, "Enter the transaction ID"),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

/** "I have paid" — records the transaction ID for a platform admin to confirm. */
export async function submitPaymentProof(slug: string, formData: FormData): Promise<ActionResult> {
  const gate = await ownerGate(slug);
  if (!gate.ok) return gate;
  const parsed = PaySchema.safeParse({
    invoiceId: formData.get("invoiceId"),
    method: formData.get("method"),
    senderNumber: formData.get("senderNumber") ?? undefined,
    trxId: formData.get("trxId"),
    note: formData.get("note") ?? undefined,
  });
  if (!parsed.success) return failed(parsed.error);
  const d = parsed.data;

  const res = await submitPayment(gate.access.workspaceId, d.invoiceId, {
    method: d.method,
    senderNumber: d.senderNumber || undefined,
    trxId: d.trxId,
    note: d.note || undefined,
  });
  if (!res.ok) return res;

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Subscription",
    entityId: gate.access.workspaceId,
    entityLabel: "Billing",
    summary: `Payment submitted for confirmation (${d.method.toLowerCase()})`,
  });
  revalidatePath(`/${slug}/settings/billing`);
  return { ok: true };
}

/** Drop a payment request that has not been paid. */
export async function cancelPaymentRequest(slug: string, invoiceId: string): Promise<ActionResult> {
  const gate = await ownerGate(slug);
  if (!gate.ok) return gate;
  const res = await prisma.billingInvoice.updateMany({
    where: { id: invoiceId, workspaceId: gate.access.workspaceId, status: "PENDING", submittedAt: null },
    data: { status: "VOID" },
  });
  if (res.count !== 1) return { ok: false, error: "That request can no longer be cancelled" };
  revalidatePath(`/${slug}/settings/billing`);
  return { ok: true };
}
