import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { PLANS, accessState, daysLeft } from "@/lib/plans";
import { AdminTenantActions } from "@/components/admin/tenant-actions";

export const dynamic = "force-dynamic";

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePlatformAdmin();
  const { q } = await searchParams;
  const term = (q ?? "").trim();

  const [workspaces, pendingPayments] = await Promise.all([
    prisma.workspace.findMany({
      where: term
        ? {
            OR: [
              { name: { contains: term, mode: "insensitive" } },
              { slug: { contains: term, mode: "insensitive" } },
              { memberships: { some: { user: { email: { contains: term, mode: "insensitive" } } } } },
            ],
          }
        : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        subscription: true,
        memberships: {
          where: { role: "OWNER" },
          select: { user: { select: { email: true } } },
          take: 1,
        },
        _count: { select: { orders: true, memberships: true, products: true } },
      },
    }),
    prisma.billingInvoice.count({ where: { status: "PENDING", submittedAt: { not: null } } }),
  ]);

  return (
    <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Platform admin</h1>
          <p className="text-sm text-muted-foreground">{workspaces.length} workspace(s)</p>
        </div>
        <nav className="flex gap-2 text-sm">
          <Link href="/admin/payments" className="rounded-md border px-3 py-1.5">
            Payments{pendingPayments ? ` (${pendingPayments} waiting)` : ""}
          </Link>
          <Link href="/" className="rounded-md border px-3 py-1.5">
            Back to app
          </Link>
        </nav>
      </header>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={term}
          placeholder="Search name, slug or owner email"
          className="h-9 w-full max-w-sm rounded-md border bg-background px-3 text-sm"
        />
        <button className="rounded-md border px-3 text-sm">Search</button>
      </form>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">Workspace</th>
              <th className="p-2">Owner</th>
              <th className="p-2">Plan</th>
              <th className="p-2">State</th>
              <th className="p-2 text-right">Orders</th>
              <th className="p-2 text-right">Team</th>
              <th className="p-2">Created</th>
              <th className="p-2">Manage</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w) => {
              const sub = w.subscription;
              const state = accessState(sub);
              const until =
                sub?.status === "TRIALING" ? sub.trialEndsAt : (sub?.currentPeriodEnd ?? null);
              return (
                <tr key={w.id} className="border-t align-top">
                  <td className="p-2">
                    <div className="font-medium">{w.name}</div>
                    <div className="text-xs text-muted-foreground">/{w.slug}</div>
                  </td>
                  <td className="p-2 text-xs">{w.memberships[0]?.user.email ?? "—"}</td>
                  <td className="p-2">
                    {PLANS[(sub?.planKey as keyof typeof PLANS) ?? "LEGACY"]?.name ?? sub?.planKey}
                  </td>
                  <td className="p-2">
                    <div>{state}</div>
                    {until ? (
                      <div className="text-xs text-muted-foreground">
                        {until.toISOString().slice(0, 10)} · {daysLeft(until)}d
                      </div>
                    ) : null}
                  </td>
                  <td className="p-2 text-right tabular-nums">{w._count.orders}</td>
                  <td className="p-2 text-right tabular-nums">{w._count.memberships}</td>
                  <td className="p-2 text-xs">{w.createdAt.toISOString().slice(0, 10)}</td>
                  <td className="p-2">
                    <AdminTenantActions
                      workspaceId={w.id}
                      planKey={sub?.planKey ?? "LEGACY"}
                      status={sub?.status ?? "ACTIVE"}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
