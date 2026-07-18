import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href={`/${slug}/customers`} className="text-sm text-muted-foreground underline">
        ← Customers
      </Link>
      <div>
        <h1 className="text-2xl font-bold">{customer.name}</h1>
        <p className="text-sm text-muted-foreground">
          {customer.phone ?? "no phone"}
          {customer.address ? ` · ${customer.address}` : ""}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Orders</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">{orders.length}</CardContent>
        </Card>
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
        {orders.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No orders yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                {canViewProfit && <TableHead className="text-right">Profit</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>{o.date}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{o.status}</Badge>
                  </TableCell>
                  <TableCell>{o.paymentStatus}</TableCell>
                  <TableCell className="text-right">{o.itemCount}</TableCell>
                  <TableCell className="text-right">{o.totals.customerTotal.toFixed(2)}</TableCell>
                  {canViewProfit && (
                    <TableCell className="text-right">{o.totals.netProfit.toFixed(2)}</TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
