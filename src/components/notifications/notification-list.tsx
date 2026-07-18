"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  markNotificationRead,
  markAllNotificationsRead,
} from "@/server/actions/notifications";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Notification = {
  id: string;
  type: string;
  message: string;
  read: boolean;
  createdAt: string;
};

const TYPE_LABEL: Record<string, string> = {
  LOW_STOCK: "Low stock",
  EXPIRY: "Expiry",
  OVERDUE_PAYMENT: "Overdue",
  NEW_ORDER: "New order",
  GENERAL: "General",
};

export function NotificationList({
  slug,
  notifications,
}: {
  slug: string;
  notifications: Notification[];
}) {
  const router = useRouter();
  const unread = notifications.filter((n) => !n.read).length;

  async function onRead(id: string) {
    const res = await markNotificationRead(slug, id);
    if (!res.ok) return toast.error(res.error);
    router.refresh();
  }
  async function onReadAll() {
    const res = await markAllNotificationsRead(slug);
    if (!res.ok) return toast.error(res.error);
    toast.success("All marked read");
    router.refresh();
  }

  if (notifications.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No notifications.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onReadAll} disabled={unread === 0}>
          Mark all read ({unread})
        </Button>
      </div>
      <ul className="space-y-2">
        {notifications.map((n) => (
          <li
            key={n.id}
            className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-sm ${
              n.read ? "opacity-60" : "bg-accent/40"
            }`}
          >
            <div className="flex items-center gap-3">
              <Badge variant="secondary">{TYPE_LABEL[n.type] ?? n.type}</Badge>
              <div>
                <div>{n.message}</div>
                <div className="text-xs text-muted-foreground">{n.createdAt}</div>
              </div>
            </div>
            {!n.read && (
              <Button variant="ghost" size="sm" onClick={() => onRead(n.id)}>
                Mark read
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
