import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { refreshOverdueAlerts } from "@/lib/finance";
import { NotificationList } from "@/components/notifications/notification-list";
import { serverT } from "@/lib/session";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Bell } from "lucide-react";

const PAGE_SIZE = 50;

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { workspace: slug } = await params;
  const page = parsePage((await searchParams).page);
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");

  // Overdue alerts are derived from order dates, so nothing but the passage of
  // time creates them — and the only place that ever recomputed them was the
  // treasury page, which STAFF and MANAGER can't open at all. A week without
  // the owner looking at the treasury meant a week with no overdue
  // notifications for anybody, on the very screen whose job is to list them.
  //
  // Recomputed here instead, where it is cheap to justify: someone opening the
  // notifications page is asking for the current picture by definition. The
  // inventory alerts already refresh on the writes that move stock, so this is
  // the one kind that needed a reader to trigger it.
  await refreshOverdueAlerts(access.workspaceId);

  const [notificationCount, notifications] = await Promise.all([
    prisma.notification.count({ where: { workspaceId: access.workspaceId } }),
    prisma.notification.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: [{ read: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const rows = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    message: n.message,
    link: n.link,
    read: n.read,
    // Full ISO (with Z) so the client can compute correct relative times and
    // render the absolute stamp in the viewer's own timezone.
    createdAt: n.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <PageHeader icon={<Bell />} color="blue" title={(await serverT())("notifications")} count={notificationCount} />
      <NotificationList slug={slug} notifications={rows} />
      <Pagination
        page={page}
        totalPages={Math.ceil(notificationCount / PAGE_SIZE)}
        basePath={`/${slug}/notifications`}
      />
    </div>
  );
}
