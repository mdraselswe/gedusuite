import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import type { SessionMembership } from "@/lib/auth";
import { translate, isLocale, type Locale, type MsgKey } from "@/lib/i18n";

export function auth() {
  return getServerSession(authOptions);
}

/** Server-side translator bound to the signed-in user's locale. */
export async function serverT(): Promise<(k: MsgKey) => string> {
  const session = await auth();
  const locale: Locale = isLocale(session?.user?.locale) ? session!.user!.locale! : "en";
  return (k) => translate(locale, k);
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
