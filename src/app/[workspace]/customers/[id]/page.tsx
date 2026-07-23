import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerOrdersTable } from "@/components/customers/customer-orders-table";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "customers", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const canViewProfit = can(access.role, "reports", "view", access.permissions);

  const customer = await prisma.customer.findFirst({
    where: { id, workspaceId: access.workspaceId },
    include: {
      orders: {
        orderBy: { date: "desc" },
        include: { items: { include: { returns: true } } },
      },
    },
  });
  if (!customer) notFound();

  const orders = customer.orders.map((o) => ({
    id: o.id,
    date: o.date.toISOString().slice(0, 10),
    status: o.status,
    paymentStatus: o.paymentStatus,
    itemCount: o.items.length,
    totals: computeOrderTotals(o),
  }));

  const lifetime = orders
    .filter((o) => o.status !== "CANCELLED")
    .reduce((s, o) => s + o.totals.customerTotal, 0);
  const outstanding = orders
    .filter((o) => o.status !== "CANCELLED" && o.paymentStatus !== "PAID")
    .reduce((s, o) => s + o.totals.customerTotal, 0);
  // Lifetime profit from this customer (cost/profit is reports-gated).
  const totalProfit = orders
    .filter((o) => o.status !== "CANCELLED")
    .reduce((s, o) => s + o.totals.netProfit, 0);

  return (
    <div className="space-y-6">
      <Link href={`/${slug}/customers`} className="text-sm text-muted-foreground underline">
        ← Customers
      </Link>
      <div>
        <h1 className="text-2xl font-bold">{customer.name}</h1>
        <p className="text-sm text-muted-foreground">
          {customer.phone ?? "no phone"}
          {customer.altPhone ? ` / ${customer.altPhone}` : ""}
          {customer.address ? ` · ${customer.address}` : ""}
        </p>
      </div>

      <div className={`grid gap-4 sm:grid-cols-3 ${canViewProfit ? "lg:grid-cols-4" : ""}`}>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Orders</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{orders.length}</CardContent>
        </Card>
        {canViewProfit && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total profit
              </CardTitle>
            </CardHeader>
            <CardContent
              className={`text-2xl font-bold ${totalProfit < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}
            >
              {totalProfit.toFixed(2)}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Lifetime value
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{lifetime.toFixed(2)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Outstanding
            </CardTitle>
          </CardHeader>
          <CardContent
            className={`text-2xl font-bold ${outstanding > 0 ? "text-destructive" : ""}`}
          >
            {outstanding.toFixed(2)}
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold">Order history</h2>
        <CustomerOrdersTable
          slug={slug}
          canViewProfit={canViewProfit}
          rows={orders.map((o) => ({
            id: o.id,
            date: o.date,
            status: o.status,
            paymentStatus: o.paymentStatus,
            itemCount: o.itemCount,
            customerTotal: o.totals.customerTotal,
            netProfit: o.totals.netProfit,
          }))}
        />
      </div>
    </div>
  );
}
