import { notFound } from "next/navigation";
import {
  LayoutDashboard,
  Package,
  ShoppingCart,
  Receipt,
  Users,
  Handshake,
  Wallet,
  ClipboardList,
  BarChart3,
  UserCog,
  DatabaseBackup,
  Palette,
} from "lucide-react";
import { requireMembership } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/rbac";
import { getUserPrefs } from "@/lib/user-prefs";
import { translate, isLocale, type Locale } from "@/lib/i18n";
import { AppShell, type NavItem } from "@/components/layout/app-shell";

// Identity helper so each object literal below is individually contextually
// typed against NavItem (narrowing `color` to the SectionColor union) instead
// of being widened to `string` the way a single array-level annotation would.
function navItem(n: NavItem & { show: boolean }) {
  return n;
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const { user, membership } = await requireMembership(slug);

  // Was 3 sequential DB round trips (workspace -> locale -> notif count) on
  // every navigation; each round trip costs ~300ms over a long-haul network
  // link, so this alone was adding ~600ms of pure latency per page. Run them
  // concurrently, and reuse getUserPrefs (React cache()) so the root layout's
  // identical user-prefs query isn't fetched twice per request.
  const [workspace, dbUser, unread] = await Promise.all([
    prisma.workspace.findUnique({ where: { slug }, select: { name: true } }),
    getUserPrefs(user.id),
    prisma.notification.count({
      where: { workspaceId: membership.workspaceId, read: false },
    }),
  ]);
  if (!workspace) notFound();

  const rawLocale = dbUser?.locale;
  const locale: Locale = isLocale(rawLocale) ? rawLocale : "en";
  const t = (k: Parameters<typeof translate>[1]) => translate(locale, k);

  const role = membership.role;
  const nav = [
    navItem({ href: `/${slug}/dashboard`, label: t("dashboard"), icon: <LayoutDashboard className="size-4" />, color: "blue", show: true }),
    navItem({
      href: `/${slug}/products`,
      label: t("products"),
      icon: <Package className="size-4" />,
      color: "violet",
      show: can(role, "products", "view"),
    }),
    navItem({
      href: `/${slug}/purchases`,
      label: t("purchases"),
      icon: <ShoppingCart className="size-4" />,
      color: "orange",
      show: can(role, "purchases", "view"),
    }),
    navItem({
      href: `/${slug}/sales/orders`,
      label: t("sales"),
      icon: <Receipt className="size-4" />,
      color: "emerald",
      show: can(role, "sales", "view"),
    }),
    navItem({
      href: `/${slug}/customers`,
      label: t("customers"),
      icon: <Users className="size-4" />,
      color: "pink",
      show: can(role, "customers", "view"),
    }),
    navItem({
      href: `/${slug}/partners`,
      label: t("partners"),
      icon: <Handshake className="size-4" />,
      color: "cyan",
      show: can(role, "partners", "view"),
    }),
    navItem({
      href: `/${slug}/treasury`,
      label: t("treasury"),
      icon: <Wallet className="size-4" />,
      color: "amber",
      show: can(role, "treasury", "view"),
    }),
    navItem({
      href: `/${slug}/internal-purchases`,
      label: t("internal"),
      icon: <ClipboardList className="size-4" />,
      color: "indigo",
      show: can(role, "internal-purchases", "view"),
    }),
    navItem({
      href: `/${slug}/reports`,
      label: t("reports"),
      icon: <BarChart3 className="size-4" />,
      color: "teal",
      show: can(role, "reports", "view"),
    }),
    navItem({
      href: `/${slug}/settings/team`,
      label: t("team"),
      icon: <UserCog className="size-4" />,
      color: "slate",
      show: can(role, "team", "view"),
    }),
    navItem({
      href: `/${slug}/settings/backup`,
      label: t("backup"),
      icon: <DatabaseBackup className="size-4" />,
      color: "rose",
      show: can(role, "backup", "view"),
    }),
    navItem({
      href: `/${slug}/settings/appearance`,
      label: t("appearance"),
      icon: <Palette className="size-4" />,
      color: "fuchsia",
      show: true,
    }),
  ].filter((n) => n.show);

  return (
    <AppShell
      slug={slug}
      workspaceName={workspace.name}
      nav={nav}
      unread={unread}
      role={membership.role}
      notifLabel={t("notifications")}
    >
      {children}
    </AppShell>
  );
}
