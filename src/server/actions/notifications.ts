"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { workspaceAccess } from "@/lib/authz";

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function markNotificationRead(
  slug: string,
  id: string,
): Promise<ActionResult> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Access denied" };
  await prisma.notification.updateMany({
    where: { id, workspaceId: access.workspaceId },
    data: { read: true },
  });
  revalidatePath(`/${slug}/notifications`);
  return { ok: true };
}

export async function markAllNotificationsRead(slug: string): Promise<ActionResult> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Access denied" };
  await prisma.notification.updateMany({
    where: { workspaceId: access.workspaceId, read: false },
    data: { read: true },
  });
  revalidatePath(`/${slug}/notifications`);
  return { ok: true };
}
