import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import type { SessionMembership } from "@/lib/auth";

export function auth() {
  return getServerSession(authOptions);
}

/** Require a logged-in user; redirect to /login otherwise. */
export async function requireUser() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user;
}

/**
 * Require membership in the workspace identified by `slug`.
 * Redirects to /login if unauthenticated, or / if not a member.
 */
export async function requireMembership(slug: string): Promise<{
  user: Awaited<ReturnType<typeof requireUser>>;
  membership: SessionMembership;
}> {
  const user = await requireUser();
  const membership = user.memberships.find((m) => m.slug === slug);
  if (!membership) redirect("/");
  return { user, membership };
}
