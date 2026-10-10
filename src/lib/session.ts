import { cache } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import type { SessionMembership } from "@/lib/auth";
import { translate, isLocale, type Locale, type MsgKey } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { sessionIsVoid } from "@/lib/session-validity";

/**
 * Cached per-request: a single page render calls this many times over (root
 * layout, workspace layout, the page's own requireMembership, workspaceAccess,
 * serverT). Each uncached call re-reads the cookie and re-decrypts the session
 * JWE from scratch. The cookie can't change mid-request, so one decode is
 * enough — React dedupes within a render pass.
 */
export const auth = cache(() => getServerSession(authOptions));

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

/** One database read per request per workspace, however many callers ask. */
const membershipFor = cache(async (userId: string, slug: string) => {
  return prisma.membership.findFirst({
    where: { userId, workspace: { slug } },
    select: {
      workspaceId: true,
      role: true,
      user: { select: { sessionsValidAfter: true, email: true, emailVerified: true } },
    },
  });
});

/**
 * Require membership in the workspace identified by `slug`.
 * Redirects to /login if unauthenticated, or / if not a member.
 *
 * Read from the database, not the JWT: the JWT's membership list is a snapshot
 * from sign-in, so a person removed from a workspace — or demoted — kept the
 * old view of it until their cookie expired.
 */
export async function requireMembership(slug: string): Promise<{
  user: Awaited<ReturnType<typeof requireUser>>;
  membership: SessionMembership;
  account: { email: string; emailVerified: Date | null };
}> {
  const user = await requireUser();
  const row = await membershipFor(user.id, slug);
  if (!row) redirect("/");
  if (sessionIsVoid(user.issuedAt, row.user.sessionsValidAfter)) redirect("/login");
  return {
    user,
    membership: { workspaceId: row.workspaceId, slug, role: row.role },
    account: { email: row.user.email, emailVerified: row.user.emailVerified },
  };
}
