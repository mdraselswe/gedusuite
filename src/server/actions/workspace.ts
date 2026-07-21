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

/**
 * Rename the workspace (display name only — the slug/URL stays stable so
 * links, bookmarks, and stored notification paths keep working).
 */
export async function updateWorkspaceName(
  slug: string,
  name: string,
): Promise<ActionResult> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Workspace not found or access denied" };
  if (access.role !== "OWNER") {
    return { ok: false, error: "Only the workspace owner can rename it" };
  }
  const trimmed = name.trim();
  if (trimmed.length < 2 || trimmed.length > 100) {
    return { ok: false, error: "Name must be 2-100 characters" };
  }

  await prisma.workspace.update({
    where: { id: access.workspaceId },
    data: { name: trimmed },
  });

  // The name shows in the nav header (when no logo), invoices, and reports.
  revalidatePath(`/${slug}`, "layout");
  revalidatePath("/");
  return { ok: true };
}

// Generous ceiling for the client-downscaled PNG data URL (base64 inflates
// size ~33%; the uploader targets a ~320px-tall logo, so real uploads land
// far below this — it's a backstop against a bypassed/broken client resize.
const MAX_LOGO_BYTES = 700_000;

/**
 * Permanently delete the workspace and every row that belongs to it (all
 * relations cascade). OWNER-only, and the caller must re-type the workspace
 * name exactly — this is unrecoverable outside a JSON backup.
 */
export async function deleteWorkspace(
  slug: string,
  confirmName: string,
): Promise<ActionResult> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Workspace not found or access denied" };
  if (access.role !== "OWNER") {
    return { ok: false, error: "Only the workspace owner can delete it" };
  }
  const ws = await prisma.workspace.findUnique({
    where: { id: access.workspaceId },
    select: { name: true },
  });
  if (!ws) return { ok: false, error: "Workspace not found" };
  if (confirmName.trim() !== ws.name) {
    return { ok: false, error: "Name doesn't match — type the workspace name exactly" };
  }

  await prisma.workspace.delete({ where: { id: access.workspaceId } });
  revalidatePath("/");
  return { ok: true };
}

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
