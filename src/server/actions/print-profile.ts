"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { workspaceAccess } from "@/lib/authz";
import { recordActivity } from "@/lib/activity";
import { failed, type ActionFailure } from "@/lib/form";
import { PrintProfileSchema } from "@/lib/print-profile";

export type ActionResult = { ok: true } | ActionFailure;

const KEYS = [
  "facebook",
  "whatsapp",
  "tagline",
  "headline",
  "giftLead",
  "giftQuote",
  "giftThanks",
  "giftClosing",
] as const;

/**
 * Save the shop's printed-extras wording and contact channels.
 * Owner only, like the rest of the shop's branding.
 *
 * An empty field is stored as an empty string — "I want this blank" — not
 * dropped, so a quote someone cleared on purpose does not come back as the
 * default the next time the tag is printed.
 */
export async function updatePrintProfile(slug: string, formData: FormData): Promise<ActionResult> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Workspace not found or access denied" };
  if (access.role !== "OWNER") {
    return { ok: false, error: "Only the workspace owner can change this" };
  }

  const raw: Record<string, string> = {};
  for (const k of KEYS) raw[k] = String(formData.get(k) ?? "");
  const parsed = PrintProfileSchema.safeParse(raw);
  if (!parsed.success) return failed(parsed.error);

  await prisma.workspace.update({
    where: { id: access.workspaceId },
    data: { printProfile: parsed.data },
  });
  await recordActivity(
    { userId: access.userId, workspaceId: access.workspaceId, role: access.role, permissions: access.permissions },
    {
      action: "UPDATE",
      entity: "Workspace",
      entityId: access.workspaceId,
      entityLabel: "Printed extras",
      summary: "Gift tag and leaflet wording updated",
    },
  );

  revalidatePath(`/${slug}/settings/appearance`);
  revalidatePath(`/${slug}/sales/gift-tags`);
  revalidatePath(`/${slug}/sales/leaflet`);
  return { ok: true };
}
