"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { workspaceAccess } from "@/lib/authz";
import { uniqueWorkspaceSlug } from "@/lib/slug";

const CreateSchema = z.object({
  name: z.string().trim().min(2, "Business name is required").max(100),
  themeColor: z.string().trim().max(20).optional(),
});

export type CreateWorkspaceResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

/**
 * Create a new Workspace and make the current user its OWNER.
 * Returns the new workspace slug so the client can navigate + refresh session.
 */
export async function createWorkspace(
  formData: FormData,
): Promise<CreateWorkspaceResult> {
  const user = await requireUser();

  const parsed = CreateSchema.safeParse({
    name: formData.get("name"),
    themeColor: formData.get("themeColor") || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const slug = await uniqueWorkspaceSlug(parsed.data.name);

  await prisma.workspace.create({
    data: {
      name: parsed.data.name,
      slug,
      themeColor: parsed.data.themeColor,
      memberships: {
        create: { userId: user.id, role: "OWNER" },
      },
    },
  });

  return { ok: true, slug };
}

export type ActionResult = { ok: true } | { ok: false; error: string };

// Generous ceiling for the client-downscaled PNG data URL (base64 inflates
// size ~33%; the uploader targets a ~320px-tall logo, so real uploads land
// far below this — it's a backstop against a bypassed/broken client resize.
const MAX_LOGO_BYTES = 700_000;

/** Set or clear the workspace's brand logo (shown in the nav header, invoices, report PDFs). */
export async function updateWorkspaceLogo(
  slug: string,
  dataUrl: string | null,
): Promise<ActionResult> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Workspace not found or access denied" };
  // Brand identity is workspace-wide, not per-user — only the owner sets it.
  if (access.role !== "OWNER") {
    return { ok: false, error: "Only the workspace owner can change the logo" };
  }
  if (dataUrl) {
    if (!dataUrl.startsWith("data:image/")) {
      return { ok: false, error: "Invalid image" };
    }
    if (dataUrl.length > MAX_LOGO_BYTES) {
      return { ok: false, error: "Logo image is too large" };
    }
  }

  await prisma.workspace.update({
    where: { id: access.workspaceId },
    data: { logoUrl: dataUrl },
  });

  // The logo shows up all over this workspace's UI (nav, invoices, reports).
  revalidatePath(`/${slug}`, "layout");
  return { ok: true };
}
