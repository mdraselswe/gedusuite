import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
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
    read: n.read,
    createdAt: n.createdAt.toISOString().slice(0, 16).replace("T", " "),
  }));

  return (
    <div className="space-y-6">
      <PageHeader icon={<Bell />} color="blue" title={(await serverT())("notifications")} />
      <NotificationList slug={slug} notifications={rows} />
      <Pagination
        page={page}
        totalPages={Math.ceil(notificationCount / PAGE_SIZE)}
        basePath={`/${slug}/notifications`}
      />
    </div>
  );
}
