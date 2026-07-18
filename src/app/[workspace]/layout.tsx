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
      <header className="sticky top-0 z-30 border-b bg-background print:hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <Link href={`/${slug}/dashboard`} className="truncate font-bold">
            {workspace.name}
          </Link>
          <div className="flex items-center gap-1">
            <Link
              href={`/${slug}/notifications`}
              className="relative inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("notifications")}
            >
              🔔
              {unread > 0 && (
                <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
            <span className="hidden text-xs font-medium text-muted-foreground sm:inline">
              {membership.role}
            </span>
            <SignOutButton />
          </div>
        </div>
        {/* Nav: horizontally scrollable pill row on phones, inline on larger screens */}
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 [scrollbar-width:none] md:px-4 [&::-webkit-scrollbar]:hidden">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="flex shrink-0 items-center rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted"
            >
              {n.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-4 sm:p-6">{children}</main>
    </div>
  );
}
