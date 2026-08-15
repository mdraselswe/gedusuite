import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { amountOutstanding } from "@/lib/order-cash";
import { dhakaDayKey, dhakaToday } from "@/lib/dhaka-time";
import { serverT } from "@/lib/session";
import { CustomerManager } from "@/components/customers/customer-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Money } from "@/components/ui/money";
import { Users } from "lucide-react";
import { round2 } from "@/lib/money";

const PAGE_SIZE = 50;

export default async function CustomersPage({
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
  if (!can(access.role, "customers", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "customers", "add", access.permissions),
    canEdit: can(access.role, "customers", "edit", access.permissions),
  };

  const [customerCount, customers] = await Promise.all([
    prisma.customer.count({ where: { workspaceId: access.workspaceId } }),
    prisma.customer.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        // Cancellations come too now. They're kept out of order counts and
        // spend, but a customer who refuses parcels costs real courier money,
        // and that was invisible here — the one thing worth knowing before
        // shipping to them again.
        orders: {
          include: { items: { include: { returns: true } } },
        },
      },
    }),
  ]);

  const today = dhakaToday();

  const rows = customers.map((c) => {
    const live = c.orders.filter((o) => o.status !== "CANCELLED");
    // What they still owe, net of anything already paid towards it. This used
    // to add up whole order totals for anything not marked PAID, so a 5,000
    // order settled with a 4,000 advance was chased for the full 5,000 — and
    // this page and the treasury's "Due" disagreed by every advance ever taken.
    const outstanding = live.reduce(
      (s, o) => s + amountOutstanding(o, computeOrderTotals(o)),
      0,
    );
    // What they have been worth: everything they have actually bought.
    const lifetime = live.reduce((s, o) => s + computeOrderTotals(o).customerTotal, 0);
    const lastOrder = live.reduce<Date | null>(
      (latest, o) => (!latest || o.date > latest ? o.date : latest),
      null,
    );
    const lastOrderDay = lastOrder ? dhakaDayKey(lastOrder) : null;
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      altPhone: c.altPhone,
      address: c.address,
      notes: c.notes,
      orderCount: live.length,
      cancelledCount: c.orders.length - live.length,
      outstanding: round2(outstanding),
      lifetime: round2(lifetime),
      lastOrderDay,
      // Worked out here rather than in the browser: the client would compute it
      // against its own clock and its own timezone, and a number that differs
      // between the server render and the first paint is a hydration mismatch.
      daysSinceOrder:
        lastOrderDay === null
          ? null
          : Math.round(
              (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastOrderDay}T00:00:00Z`)) /
                86_400_000,
            ),
    };
  });

  const totalDue = round2(rows.reduce((s, r) => s + r.outstanding, 0));
  const owingCount = rows.filter((r) => r.outstanding > 0).length;

  return (
    <div className="space-y-6">
      {/* The money goes in the header, the way it does on treasury — it was a
          line of grey text wedged between the search box and the filters. */}
      <PageHeader
        icon={<Users />}
        color="pink"
        title={(await serverT())("customers")}
        count={customerCount}
        action={
          totalDue > 0 ? (
            <span className="text-sm text-muted-foreground">
              Owed by customers:{" "}
              <Money value={totalDue} tone="negative" className="text-lg font-bold" />
              <span className="ml-1">
                across {owingCount} {owingCount === 1 ? "customer" : "customers"}
              </span>
            </span>
          ) : undefined
        }
      />
      <CustomerManager slug={slug} customers={rows} perms={perms} />
      <Pagination
        page={page}
        totalPages={Math.ceil(customerCount / PAGE_SIZE)}
        basePath={`/${slug}/customers`}
      />
    </div>
  );
}
