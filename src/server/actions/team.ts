"use server";

import { randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import type { Role } from "@prisma/client";
import { failed, type ActionFailure } from "@/lib/form";
import { recordActivity } from "@/lib/activity";

const ROLES = ["OWNER", "PARTNER", "MANAGER", "STAFF"] as const;

// How long an invite link stays usable. Not exported: a "use server" file may
// only export async functions, because everything it exports becomes a callable
// server endpoint — and a number cannot be one. tsc has no opinion on that
// rule, so it only surfaces at build time.
const INVITE_TTL_DAYS = 14;

const InviteSchema = z.object({
  slug: z.string().min(1),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  role: z.enum(ROLES),
});

export type InviteResult =
  | { ok: true; inviteUrl: string }
  | ActionFailure;

/** OWNER-only: invite an email to the workspace with a role. */
export async function inviteMember(formData: FormData): Promise<InviteResult> {
  const user = await requireUser();

  const parsed = InviteSchema.safeParse({
    slug: formData.get("slug"),
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return failed(parsed.error);
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
  // A fortnight is long enough for someone to get round to it and short enough
  // that a link left in a chat thread stops being a way in. Re-inviting issues
  // a fresh token and a fresh window, so nothing is lost by it lapsing.
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
  await prisma.invite.upsert({
    where: { email_workspaceId: { email, workspaceId } },
    create: {
      email,
      workspaceId,
      role: role as Role,
      token,
      invitedBy: user.id,
      expiresAt,
    },
    update: { role: role as Role, token, invitedBy: user.id, acceptedAt: null, expiresAt },
  });

  revalidatePath(`/${slug}/settings/team`);
  return {
    ok: true,
    // No email service in Phase 0 — hand the link back so the OWNER can share it.
    inviteUrl: `/invite/${token}`,
  };
}

export type Result = { ok: true } | ActionFailure;

/** OWNER-only: change a member's role. Blocked if it would leave the workspace with no Owner. */
export async function updateMemberRole(
  slug: string,
  membershipId: string,
  role: Role,
): Promise<Result> {
  const gate = await requireAccess(slug, "team", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const target = await prisma.membership.findUnique({
    where: { id: membershipId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!target || target.workspaceId !== workspaceId) {
    return { ok: false, error: "Member not found" };
  }

  if (target.role === "OWNER" && role !== "OWNER") {
    const ownerCount = await prisma.membership.count({ where: { workspaceId, role: "OWNER" } });
    if (ownerCount <= 1) return { ok: false, error: "Workspace must have at least one Owner" };
  }

  await prisma.membership.update({ where: { id: membershipId }, data: { role } });

  // Who can see the treasury and who can hand out profit is decided here, so
  // a role change is the one edit an audit trail exists for above all others.
  await recordActivity(gate.access, {
    action: "UPDATE",
    entity: "Membership",
    entityId: membershipId,
    entityLabel: target.user.name ?? target.user.email,
    summary: `Role changed from ${target.role} to ${role}`,
    changes: { role: { from: target.role, to: role } },
  });

  revalidatePath(`/${slug}/settings/team`);
  return { ok: true };
}

/** OWNER-only: remove a member. Blocked if the target is the workspace's only Owner. */
export async function removeMember(slug: string, membershipId: string): Promise<Result> {
  const gate = await requireAccess(slug, "team", "full");
  if (!gate.ok) return gate;
  const workspaceId = gate.access.workspaceId;

  const target = await prisma.membership.findUnique({
    where: { id: membershipId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!target || target.workspaceId !== workspaceId) {
    return { ok: false, error: "Member not found" };
  }

  if (target.role === "OWNER") {
    const ownerCount = await prisma.membership.count({ where: { workspaceId, role: "OWNER" } });
    if (ownerCount <= 1) return { ok: false, error: "Workspace must have at least one Owner" };
  }

  await prisma.membership.delete({ where: { id: membershipId } });

  // Recorded before the row is gone, and the actor's name is snapshotted, so
  // removing somebody never removes the account of it.
  await recordActivity(gate.access, {
    action: "DELETE",
    entity: "Membership",
    entityId: membershipId,
    entityLabel: target.user.name ?? target.user.email,
    summary: `Removed from the workspace (was ${target.role})`,
  });

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
  | ActionFailure;

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
  // Null means an invite issued before invites had an end date — left valid
  // rather than retroactively cancelled on people mid-onboarding.
  if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
    return {
      ok: false,
      error: "This invite has expired. Ask the workspace owner to send a new one.",
    };
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
