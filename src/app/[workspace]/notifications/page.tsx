import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { NotificationList } from "@/components/notifications/notification-list";
import { serverT } from "@/lib/session";

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");

  const notifications = await prisma.notification.findMany({
    where: { workspaceId: access.workspaceId },
    orderBy: [{ read: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const rows = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    message: n.message,
    read: n.read,
    createdAt: n.createdAt.toISOString().slice(0, 16).replace("T", " "),
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">{(await serverT())("notifications")}</h1>
      <NotificationList slug={slug} notifications={rows} />
    </div>
  );
}
