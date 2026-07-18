"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
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
