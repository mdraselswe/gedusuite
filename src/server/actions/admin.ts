"use server";

import { revalidatePath } from "next/cache";
import { platformAdminOrNull } from "@/lib/platform-admin";
import { approveInvoice, rejectInvoice, setSubscription } from "@/lib/billing-admin";
import type { ActionFailure } from "@/lib/form";

/**
 * Platform-admin actions. Each one re-checks the allow-list itself: the page
 * being hidden from everybody else is a convenience, not the protection.
 */
export type ActionResult = { ok: true } | ActionFailure;

const denied: ActionFailure = { ok: false, error: "Not allowed" };

export async function approvePayment(invoiceId: string): Promise<ActionResult> {
  const admin = await platformAdminOrNull();
  if (!admin) return denied;
  const res = await approveInvoice(invoiceId, admin.id);
  if (!res.ok) return res;
  revalidatePath("/admin");
  revalidatePath("/admin/payments");
  return { ok: true };
}

export async function rejectPayment(invoiceId: string, reason: string): Promise<ActionResult> {
  const admin = await platformAdminOrNull();
  if (!admin) return denied;
  const res = await rejectInvoice(invoiceId, admin.id, reason);
  if (!res.ok) return res;
  revalidatePath("/admin/payments");
  return { ok: true };
}

export async function adminSetSubscription(
  workspaceId: string,
  change: {
    planKey?: string;
    status?: "TRIALING" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
    extendDays?: number;
    notes?: string;
  },
): Promise<ActionResult> {
  const admin = await platformAdminOrNull();
  if (!admin) return denied;
  const res = await setSubscription(workspaceId, change);
  if (!res.ok) return res;
  revalidatePath("/admin");
  return { ok: true };
}
