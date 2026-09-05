"use server";

import { revalidatePath } from "next/cache";
import { requireAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { DISTRICTS } from "@/lib/bd-locations";
import { recordActivity } from "@/lib/activity";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function setOrderShipDistrict(
  slug: string,
  orderId: string,
  district: string,
): Promise<ActionResult> {
  const gate = await requireAccess(slug, "sales", "edit");
  if (!gate.ok) return gate;

  const next = district.trim();
  if (next && !DISTRICTS.includes(next)) {
    return { ok: false, error: "Choose a valid district" };
  }

  const before = await prisma.order.findFirst({
    where: { id: orderId, workspaceId: gate.access.workspaceId },
    select: { id: true, orderNo: true, shipDistrict: true, customer: { select: { name: true } } },
  });
  if (!before) return { ok: false, error: "Order not found" };

  const value = next || null;
  if (before.shipDistrict === value) return { ok: true };

  await prisma.order.update({
    where: { id: orderId },
    data: { shipDistrict: value },
  });

  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Order",
    entityId: orderId,
    entityLabel: `${before.orderNo != null ? `#${before.orderNo}` : orderId.slice(-8).toUpperCase()} · ${before.customer?.name ?? "Walk-in"}`,
    summary: value ? `District tagged as ${value}` : "District tag cleared",
    changes: { shipDistrict: { from: before.shipDistrict, to: value } },
  });

  revalidatePath(`/${slug}/reports`);
  revalidatePath(`/${slug}/sales/orders`);
  return { ok: true };
}
