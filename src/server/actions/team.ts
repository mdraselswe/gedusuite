"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import type { Role } from "@prisma/client";

const ROLES = ["OWNER", "PARTNER", "MANAGER", "STAFF"] as const;

const InviteSchema = z.object({
  slug: z.string().min(1),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  role: z.enum(ROLES),
});

export type InviteResult =
  | { ok: true; inviteUrl: string }
  | { ok: false; error: string };

/** OWNER-only: invite an email to the workspace with a role. */
export async function inviteMember(formData: FormData): Promise<InviteResult> {
  const user = await requireUser();

  const parsed = InviteSchema.safeParse({
    slug: formData.get("slug"),
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { slug, email, role } = parsed.data;

  // Workspace+membership combined into one round trip (was 2 sequential),
  // run concurrently with the existing-user lookup (independent of it).
  const [membership, existingUser] = await Promise.all([
    prisma.membership.findFirst({
      where: { userId: user.id, workspace: { slug } },
      select: { workspaceId: true, role: true, permissions: true },
    }),
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
  ]);
  if (!membership) return { ok: false, error: "Workspace not found" };

  // Authorize: only members with full Team access (OWNER) may invite.
  if (!can(membership.role, "team", "full", membership.permissions)) {
    return { ok: false, error: "You do not have permission to invite members" };
  }
  const workspaceId = membership.workspaceId;

  // Already a member? (only needs a round trip when the email is a known user)
  if (existingUser) {
    const already = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: existingUser.id, workspaceId } },
      select: { id: true },
    });
    if (already) return { ok: false, error: "That user is already a member" };
  }

  const token = randomBytes(24).toString("hex");
  await prisma.invite.upsert({
    where: { email_workspaceId: { email, workspaceId } },
    create: {
      email,
      workspaceId,
      role: role as Role,
      token,
      invitedBy: user.id,
    },
    update: { role: role as Role, token, invitedBy: user.id, acceptedAt: null },
  });

  revalidatePath(`/${slug}/settings/team`);
  return {
    ok: true,
    // No email service in Phase 0 — hand the link back so the OWNER can share it.
    inviteUrl: `/invite/${token}`,
  };
}

export type Result = { ok: true } | { ok: false; error: string };

/** OWNER-only: change a member's role. Blocked if it would leave the workspace with no Owner. */
export async function updateMemberRole(
  slug: string,
  membershipId: string,
  role: Role,
): Promise<Result> {
  const gate = await requireAccess(slug, "team", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const target = await prisma.membership.findUnique({ where: { id: membershipId } });
  if (!target || target.workspaceId !== workspaceId) {
    return { ok: false, error: "Member not found" };
  }

  if (target.role === "OWNER" && role !== "OWNER") {
    const ownerCount = await prisma.membership.count({ where: { workspaceId, role: "OWNER" } });
    if (ownerCount <= 1) return { ok: false, error: "Workspace must have at least one Owner" };
  }

  await prisma.membership.update({ where: { id: membershipId }, data: { role } });
  revalidatePath(`/${slug}/settings/team`);
  return { ok: true };
}

/** OWNER-only: remove a member. Blocked if the target is the workspace's only Owner. */
export async function removeMember(slug: string, membershipId: string): Promise<Result> {
  const gate = await requireAccess(slug, "team", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const target = await prisma.membership.findUnique({ where: { id: membershipId } });
  if (!target || target.workspaceId !== workspaceId) {
    return { ok: false, error: "Member not found" };
  }

  if (target.role === "OWNER") {
    const ownerCount = await prisma.membership.count({ where: { workspaceId, role: "OWNER" } });
    if (ownerCount <= 1) return { ok: false, error: "Workspace must have at least one Owner" };
  }

  await prisma.membership.delete({ where: { id: membershipId } });
  revalidatePath(`/${slug}/settings/team`);
  return { ok: true };
}

export async function revokeInvite(formData: FormData): Promise<void> {
  const user = await requireUser();
  const slug = String(formData.get("slug") ?? "");
  const inviteId = String(formData.get("inviteId") ?? "");

  const invite = await prisma.invite.findUnique({
    where: { id: inviteId },
    include: { workspace: true },
  });
  if (!invite) return;

  const membership = await prisma.membership.findUnique({
    where: {
      userId_workspaceId: { userId: user.id, workspaceId: invite.workspaceId },
    },
  });
  if (!membership || !can(membership.role, "team", "full", membership.permissions)) {
    return;
  }

  await prisma.invite.delete({ where: { id: inviteId } });
  revalidatePath(`/${slug}/settings/team`);
}

export type AcceptResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

/** Accept an invite as the currently logged-in user (email must match). */
export async function acceptInvite(token: string): Promise<AcceptResult> {
  const user = await requireUser();

  const invite = await prisma.invite.findUnique({
    where: { token },
    include: { workspace: true },
  });
  if (!invite || invite.acceptedAt) {
    return { ok: false, error: "This invite is invalid or has already been used" };
  }
  if (invite.email.toLowerCase() !== (user.email ?? "").toLowerCase()) {
    return {
      ok: false,
      error: `This invite is for ${invite.email}. Sign in with that email to accept.`,
    };
  }

  await prisma.$transaction([
    prisma.membership.upsert({
      where: {
        userId_workspaceId: { userId: user.id, workspaceId: invite.workspaceId },
      },
      create: {
        userId: user.id,
        workspaceId: invite.workspaceId,
        role: invite.role,
        invitedBy: invite.invitedBy,
      },
      update: { role: invite.role },
    }),
    prisma.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    }),
  ]);

  return { ok: true, slug: invite.workspace.slug };
}
