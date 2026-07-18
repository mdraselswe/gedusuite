import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMembership, auth } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/rbac";
import { translate, isLocale, type Locale } from "@/lib/i18n";
import { SignOutButton } from "@/components/sign-out-button";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const { membership } = await requireMembership(slug);

  const [workspace, session] = await Promise.all([
    prisma.workspace.findUnique({ where: { slug }, select: { name: true } }),
    auth(),
  ]);
  if (!workspace) notFound();

  let locale: Locale = "en";
  if (session?.user?.id) {
    const u = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { locale: true },
    });
    if (u && isLocale(u.locale)) locale = u.locale;
  }
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);

  const unread = await prisma.notification.count({
    where: { workspaceId: membership.workspaceId, read: false },
  });

  const role = membership.role;
  const nav = [
    { href: `/${slug}/dashboard`, label: t("dashboard"), show: true },
    { href: `/${slug}/products`, label: t("products"), show: can(role, "products", "view") },
    { href: `/${slug}/purchases`, label: t("purchases"), show: can(role, "purchases", "view") },
    { href: `/${slug}/sales/orders`, label: t("sales"), show: can(role, "sales", "view") },
    { href: `/${slug}/customers`, label: t("customers"), show: can(role, "customers", "view") },
    { href: `/${slug}/partners`, label: t("partners"), show: can(role, "partners", "view") },
    { href: `/${slug}/treasury`, label: t("treasury"), show: can(role, "treasury", "view") },
    {
      href: `/${slug}/internal-purchases`,
      label: t("internal"),
      show: can(role, "internal-purchases", "view"),
    },
    { href: `/${slug}/reports`, label: t("reports"), show: can(role, "reports", "view") },
    { href: `/${slug}/settings/team`, label: t("team"), show: can(role, "team", "view") },
    { href: `/${slug}/settings/backup`, label: t("backup"), show: can(role, "backup", "view") },
    { href: `/${slug}/settings/appearance`, label: t("appearance"), show: true },
  ].filter((n) => n.show);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-3 print:hidden">
        <div className="flex items-center gap-6">
          <Link href={`/${slug}/dashboard`} className="font-bold">
            {workspace.name}
          </Link>
          <nav className="hidden gap-4 text-sm text-muted-foreground sm:flex">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="hover:text-foreground">
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/${slug}/notifications`}
            className="relative text-sm text-muted-foreground hover:text-foreground"
            aria-label="Notifications"
          >
            🔔
            {unread > 0 && (
              <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </Link>
          <span className="text-xs font-medium text-muted-foreground">{membership.role}</span>
          <SignOutButton />
        </div>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
