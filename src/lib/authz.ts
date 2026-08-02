import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { can, type Access, type Module } from "@/lib/rbac";
import type { Role } from "@prisma/client";

export type WorkspaceAccess = {
  userId: string;
  workspaceId: string;
  role: Role;
  permissions: unknown;
};

/**
 * Resolve the current user's membership in `slug` from the database
 * (authoritative — picks up granular permission overrides, unlike the JWT).
 * Returns null if unauthenticated or not a member.
 */
export async function workspaceAccess(slug: string): Promise<WorkspaceAccess | null> {
  const user = await requireUser();
  // Single round trip (was 2 sequential queries): filter membership directly by
  // the workspace's slug via the relation instead of looking up the workspace
  // id first. Every server action calls this, so this halves its DB latency.
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id, workspace: { slug } },
    select: { workspaceId: true, role: true, permissions: true },
  });
  if (!membership) return null;

  return {
    userId: user.id,
    workspaceId: membership.workspaceId,
    role: membership.role,
    permissions: membership.permissions,
  };
}

/**
 * Require a specific access level on a module. Returns the access context on
 * success, or an { error } object suitable for returning from a server action.
 */
export async function requireAccess(
  slug: string,
  module: Module,
  need: Access,
): Promise<
  { ok: true; access: WorkspaceAccess } | { ok: false; error: string }
> {
  const access = await workspaceAccess(slug);
  if (!access) return { ok: false, error: "Workspace not found or access denied" };
  if (!can(access.role, module, need, access.permissions)) {
    return { ok: false, error: "You do not have permission to do that" };
  }
  return { ok: true, access };
}
