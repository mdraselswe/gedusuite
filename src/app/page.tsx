import Link from "next/link";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { SignOutButton } from "@/components/sign-out-button";
import { buttonVariants } from "@/components/ui/button";
import { ArrowRight, Boxes, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

// Role accents mirror the section-color language used across the app.
const ROLE_BADGE: Record<string, string> = {
  OWNER: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  PARTNER: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  MANAGER: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  STAFF: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
};

export default async function HomePage() {
  const user = await requireUser();
  // Display names come fresh from the DB — the JWT membership snapshot only
  // carries slugs, and names/logos can change at any time.
  const details = await prisma.workspace.findMany({
    where: { id: { in: user.memberships.map((m) => m.workspaceId) } },
    select: { id: true, name: true, logoUrl: true },
  });
  const byId = new Map(details.map((w) => [w.id, w]));
  const workspaces = user.memberships;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col p-6">
      <header className="mb-10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Boxes className="size-6" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">GeduSuite</h1>
            <p className="truncate text-sm text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <SignOutButton />
      </header>

      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Your workspaces</h2>
          {workspaces.length > 0 && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
              {workspaces.length}
            </span>
          )}
        </div>
        <Link href="/workspaces/new" className={buttonVariants({ size: "sm" })}>
          <Plus className="size-4" /> New workspace
        </Link>
      </div>

      {workspaces.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Sparkles className="size-6" />
          </span>
          <div>
            <p className="font-medium">No workspaces yet</p>
            <p className="text-sm text-muted-foreground">
              Create one to start managing your business.
            </p>
          </div>
          <Link href="/workspaces/new" className={cn(buttonVariants(), "mt-2")}>
            <Plus className="size-4" /> Create your first workspace
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {workspaces.map((w, i) => {
            const ws = byId.get(w.workspaceId);
            const name = ws?.name ?? w.slug;
            return (
              <li
                key={w.workspaceId}
                className="animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-both duration-300"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <Link
                  href={`/${w.slug}/dashboard`}
                  className="group flex items-center gap-4 rounded-xl border bg-card p-4 transition-all hover:border-primary/40 hover:shadow-md hover:shadow-primary/5"
                >
                  {ws?.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={ws.logoUrl}
                      alt={name}
                      className="size-11 shrink-0 rounded-xl border object-contain p-1"
                    />
                  ) : (
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg font-bold text-primary">
                      {name.charAt(0).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{name}</div>
                    <div className="truncate text-xs text-muted-foreground">/{w.slug}</div>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide",
                      ROLE_BADGE[w.role] ?? ROLE_BADGE.STAFF,
                    )}
                  >
                    {w.role}
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
