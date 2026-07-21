"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  markNotificationRead,
  markAllNotificationsRead,
  clearReadNotifications,
} from "@/server/actions/notifications";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Bell, ChevronRight } from "lucide-react";

type Notification = {
  id: string;
  type: string;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string; // full ISO (UTC)
};

const TYPE_LABEL: Record<string, string> = {
  LOW_STOCK: "Low stock",
  EXPIRY: "Expiry",
  OVERDUE_PAYMENT: "Overdue",
  NEW_ORDER: "New order",
  GENERAL: "General",
};

/** Local-timezone absolute stamp, e.g. "2026-07-22 14:05". */
function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2m ago" / "3h ago" / "5d ago"; falls back to the local stamp past 7 days. */
function relativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const mins = Math.max(0, Math.floor((Date.now() - then.getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return localStamp(iso);
}

export function NotificationList({
  slug,
  notifications,
}: {
  slug: string;
  notifications: Notification[];
}) {
  const router = useRouter();
  const unread = notifications.filter((n) => !n.read).length;
  const readCount = notifications.filter((n) => n.read).length;

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
  async function onClearRead() {
    const ok = await confirmDialog({
      title: "Clear read notifications?",
      description: "All notifications you've already read will be deleted.",
      confirmText: "Clear",
      destructive: true,
    });
    if (!ok) return;
    const res = await clearReadNotifications(slug);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Cleared ${res.deleted ?? 0} notification${(res.deleted ?? 0) === 1 ? "" : "s"}`);
    router.refresh();
  }

  /** Open the linked page; mark read on the way (fire-and-forget). */
  function onOpen(n: Notification) {
    if (!n.read) void markNotificationRead(slug, n.id);
    if (n.link) router.push(n.link);
  }

  if (notifications.length === 0) {
    return (
      <EmptyState icon={Bell} title="No notifications" description="You're all caught up." />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClearRead} disabled={readCount === 0}>
          Clear read
        </Button>
        <Button variant="outline" size="sm" onClick={onReadAll} disabled={unread === 0}>
          Mark all read ({unread})
        </Button>
      </div>
      <ul className="space-y-2">
        {notifications.map((n) => {
          const body = (
            <>
              <Badge variant="secondary" className="shrink-0">
                {TYPE_LABEL[n.type] ?? n.type}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="wrap-break-word">{n.message}</div>
                {/* suppressHydrationWarning: relative time depends on "now",
                    which differs between server render and client hydration */}
                <div
                  className="text-xs text-muted-foreground"
                  title={localStamp(n.createdAt)}
                  suppressHydrationWarning
                >
                  {relativeTime(n.createdAt)}
                </div>
              </div>
            </>
          );
          return (
            <li
              key={n.id}
              className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-sm ${
                n.read ? "opacity-60" : "bg-accent/40"
              }`}
            >
              {n.link ? (
                <button
                  type="button"
                  onClick={() => onOpen(n)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  {body}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
              )}
              {!n.read && (
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => onRead(n.id)}>
                  Mark read
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
