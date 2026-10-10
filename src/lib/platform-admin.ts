import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/session";

/**
 * Who runs the platform (as opposed to who runs a workspace).
 *
 * An allow-list in the environment, not a column: there is no screen and no
 * request that can make somebody a platform admin, so a bug or a compromised
 * workspace owner cannot escalate to it. Changing it is a deploy.
 */
export function platformAdminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  return Boolean(email) && platformAdminEmails().includes(email!.toLowerCase());
}

/**
 * The signed-in platform admin, or a redirect home. The address must also be
 * verified, so registering somebody else's admin address cannot be enough.
 */
export async function requirePlatformAdmin(): Promise<{ id: string; email: string }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) redirect("/login");
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user || !user.emailVerified || !isPlatformAdminEmail(user.email)) redirect("/");
  return { id: user.id, email: user.email };
}

/** Non-redirecting variant for server actions. */
export async function platformAdminOrNull(): Promise<{ id: string; email: string } | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user || !user.emailVerified || !isPlatformAdminEmail(user.email)) return null;
  return { id: user.id, email: user.email };
}
