"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Bell, Menu } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SignOutButton } from "@/components/sign-out-button";
import { cn } from "@/lib/utils";
import { sectionColorClasses, type SectionColor } from "@/lib/section-colors";

export type NavItem = {
  href: string;
  label: string;
  // A pre-rendered <Icon /> element, not the component itself — lucide icon
  // *components* are functions and can't cross the Server->Client boundary as
  // plain props, but an already-rendered element (built in the server layout)
  // can.
  icon: React.ReactNode;
  color: SectionColor;
};

function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors md:py-2",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md transition-transform group-hover:scale-110",
          sectionColorClasses[item.color],
        )}
      >
        {item.icon}
      </span>
      {item.label}
    </Link>
  );
}

export function AppShell({
  slug,
  workspaceName,
  nav,
  unread,
  role,
  notifLabel,
  children,
}: {
  slug: string;
  workspaceName: string;
  nav: NavItem[];
  unread: number;
  role: string;
  notifLabel: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const notifBadge = unread > 0 && (
    <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
      {unread > 99 ? "99+" : unread}
    </span>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-background md:flex print:hidden">
        <Link
          href={`/${slug}/dashboard`}
          className="flex h-16 shrink-0 items-center gap-2 border-b px-4 font-bold"
        >
          <span className="truncate">{workspaceName}</span>
        </Link>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {nav.map((item, i) => (
            <div
              key={item.href}
              className="animate-in fade-in-0 slide-in-from-left-2 fill-mode-both duration-300"
              style={{ animationDelay: `${i * 30}ms` }}
            >
              <NavLink item={item} active={pathname === item.href} />
            </div>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t p-3">
          <span className="text-xs font-medium text-muted-foreground">{role}</span>
          <SignOutButton />
        </div>
      </aside>

      <div className="flex flex-1 flex-col md:pl-64">
        {/* Top bar: full nav trigger on mobile, just the bell on desktop */}
        <header className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b bg-background px-4 py-3 md:justify-end print:hidden">
          <div className="flex items-center gap-1 md:hidden">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Menu"
            >
              <Menu className="size-5" />
            </button>
            <Link href={`/${slug}/dashboard`} className="truncate font-bold">
              {workspaceName}
            </Link>
          </div>
          <Link
            href={`/${slug}/notifications`}
            className="relative inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={notifLabel}
          >
            <Bell className="size-5" />
            {notifBadge}
          </Link>
        </header>
        <main className="flex-1 p-4 sm:p-6">
          {/* key={pathname} forces a remount on route change so the enter
              animation re-triggers per page instead of firing only once. */}
          <div key={pathname} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
            {children}
          </div>
        </main>
      </div>

      {/* Mobile nav drawer */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 max-w-[85vw]">
          <SheetHeader>
            <SheetTitle>{workspaceName}</SheetTitle>
          </SheetHeader>
          <nav className="flex-1 space-y-1 overflow-y-auto">
            {nav.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={pathname === item.href}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </nav>
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <span className="text-xs font-medium text-muted-foreground">{role}</span>
            <SignOutButton />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
