import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function vLabel(name: string, size: string | null, color: string | null) {
  const extra = [size, color].filter(Boolean).join(" / ");
  return extra ? `${name} (${extra})` : name;
}

export default async function OrderBreakdownPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  // Cost/profit is sensitive — gate on the same "reports" access that
  // controls whether the Profit column shows on the orders list at all.
  if (!can(access.role, "reports", "view", access.permissions)) {
    redirect(`/${slug}/sales/orders`);
  }

  const order = await prisma.order.findFirst({
    where: { id, workspaceId: access.workspaceId },
    include: {
      customer: true,
      heldBy: { include: { user: { select: { name: true, email: true } } } },
      items: {
        include: {
          returns: true,
          productVariant: {
            select: { size: true, color: true, product: { select: { name: true } } },
          },
        },
      },
      gifts: true,
    },
  });
  if (!order) notFound();

  const totals = computeOrderTotals(order);
  const deliveryCostWasBlank = order.deliveryCost == null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <Link href={`/${slug}/sales/orders`} className="text-sm text-muted-foreground underline">
          ← Orders
        </Link>
        <Link
          href={`/${slug}/sales/orders/${order.id}/invoice`}
          className="text-sm underline underline-offset-4"
        >
          View invoice
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Order calculation breakdown</h1>
        <p className="text-sm text-muted-foreground">
          #{order.id.slice(-8).toUpperCase()} · {order.date.toISOString().slice(0, 10)} ·{" "}
          {order.customer?.name ?? "Walk-in customer"}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Items</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Returned</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Line discount</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">COGS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((it) => {
                const returned = it.returns.reduce((s, r) => s + r.quantity, 0);
                const eq = Math.max(0, it.quantity - returned);
                const lineRevenue = Number(it.unitPrice) * eq;
                const lineCogs = Number(it.unitCost) * eq;
                return (
                  <TableRow key={it.id}>
                    <TableCell>
                      {vLabel(it.productVariant.product.name, it.productVariant.size, it.productVariant.color)}
                    </TableCell>
                    <TableCell className="text-right">{it.quantity}</TableCell>
                    <TableCell className="text-right">{returned || "—"}</TableCell>
                    <TableCell className="text-right">{Number(it.unitPrice).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(it.unitCost).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(it.discount).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{lineRevenue.toFixed(2)}</TableCell>
                    <TableCell className="text-right">{lineCogs.toFixed(2)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {order.gifts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gifts (not on the customer invoice)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Gift</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Total cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.gifts.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      {g.label}
                      {!g.productVariantId && (
                        <span className="ml-2 text-xs text-muted-foreground">(custom)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{g.quantity}</TableCell>
                    <TableCell className="text-right">{Number(g.unitCost).toFixed(2)}</TableCell>
                    <TableCell className="text-right">
                      {(Number(g.unitCost) * g.quantity).toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Full calculation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <Row label="Gross revenue (before returns)" value={totals.grossRevenue} />
          <Row label="Item discounts" value={-totals.itemDiscounts} />
          <Row label="Order discount" value={-totals.orderDiscount} />
          <Row label="= Net revenue" value={totals.netRevenue} bold />
          <div className="h-2" />
          <Row label="COGS (cost of goods sold)" value={-totals.cogs} />
          <Row label="Packaging cost" value={-totals.packagingCost} />
          <Row label="Gift cost" value={-totals.giftCost} />
          <Row
            label={`Delivery margin (charge ${totals.deliveryCharge.toFixed(2)} − cost ${totals.deliveryCost.toFixed(2)})`}
            value={totals.deliveryMargin}
          />
          <div className="flex justify-between border-t pt-2 text-base font-bold">
            <span>Net profit</span>
            <span>{totals.netProfit.toFixed(2)}</span>
          </div>
          <div className="h-2" />
          <Row label="Delivery charge (billed to customer)" value={totals.deliveryCharge} />
          <div className="flex justify-between border-t pt-2 text-base font-bold">
            <span>Customer total</span>
            <span>{totals.customerTotal.toFixed(2)}</span>
          </div>
          {totals.refunds > 0 && <Row label="Refunded to customer" value={-totals.refunds} />}
          {totals.returnedUnits > 0 && (
            <div className="pt-1 text-muted-foreground">{totals.returnedUnits} unit(s) returned</div>
          )}
          {deliveryCostWasBlank && (
            <p className="pt-3 text-xs text-amber-600 dark:text-amber-400">
              Delivery cost was never entered for this order — assumed equal to delivery charge
              (0 margin). If the actual courier cost was different, edit the order to set it and
              profit will update.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <Row label="Order status" value={order.status} />
          <Row
            label="Payment"
            value={`${order.paymentStatus} · ${order.paymentMethod}`}
          />
          <Row label="Held by" value={order.heldBy ? (order.heldBy.user.name ?? order.heldBy.user.email) : "—"} />
          <Row label="Cash in treasury" value={order.cashInTreasury ? "Yes" : "No"} />
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: number | string;
  bold?: boolean;
}) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span>{typeof value === "number" ? value.toFixed(2) : value}</span>
    </div>
  );
}
