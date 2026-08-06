"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Boxes, PackageX, RotateCcw, ShoppingBag, Truck } from "lucide-react";
import type { ProductReport } from "@/lib/product-report";
import { formatStock } from "@/lib/units";
import { orderSourceLabel } from "@/lib/order-source";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const money = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}`;

/** Green when it earned, red when it lost — profit is never just a number. */
function profitClass(n: number) {
  if (n < 0) return "text-destructive";
  return "text-emerald-600 dark:text-emerald-400";
}

type OrderRow = ProductReport["orders"][number];
type VariantRow = ProductReport["variants"][number];
type PurchaseRow = ProductReport["purchases"]["rows"][number];
type ReturnRow = ProductReport["returns"][number];
type AdjustmentRow = ProductReport["adjustments"][number];

export function ProductDetailView({
  slug,
  report,
  canViewProfit,
  from,
  to,
  isAllTime,
}: {
  slug: string;
  report: ProductReport;
  canViewProfit: boolean;
  from: string;
  to: string;
  isAllTime: boolean;
}) {
  const router = useRouter();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  const { product, totals, stock } = report;
  const pack = product.unitsPerPack;

  function applyRange(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/${slug}/products/${product.id}?from=${f}&to=${t}`);
  }

  const kpis: { label: string; value: string; hint?: string; className?: string }[] = [
    {
      label: "Units sold",
      value: formatStock(totals.unitsSold, pack),
      hint: totals.unitsReturned > 0 ? `${totals.unitsReturned} returned` : undefined,
    },
    { label: "Orders", value: String(totals.orders) },
    { label: "Revenue", value: money(totals.revenue) },
    ...(canViewProfit
      ? [
          {
            label: "Net profit",
            value: money(totals.netProfit),
            hint:
              totals.marginPercent != null ? `${totals.marginPercent}% margin` : undefined,
            className: profitClass(totals.netProfit),
          },
        ]
      : []),
  ];

  // The waterfall from revenue to net profit. This is the whole point of the
  // page: the reports table's per-product "profit" is only the first two
  // lines of it, and the rest can turn a healthy margin negative.
  const breakdown: { label: string; value: number; note?: string; strong?: boolean }[] = [
    { label: "Revenue (after discounts, on kept units)", value: totals.revenue },
    { label: "Cost of goods sold", value: -totals.cogs },
    { label: "Gross margin", value: totals.grossMargin, strong: true },
    {
      label: "Packaging (allocated)",
      value: -totals.packagingCost,
      note: "share of each order's packaging cost",
    },
    {
      label: "Gifts (allocated)",
      value: -totals.giftCost,
      note: "free items given away with those orders",
    },
    {
      label: "Courier COD fee (allocated)",
      value: -totals.codFeeCost,
      note: "the courier's percentage fee",
    },
    {
      label: "Delivery margin (allocated)",
      value: totals.deliveryMargin,
      note: "charged to the customer minus paid to the courier",
    },
    { label: "Net profit", value: totals.netProfit, strong: true },
  ];

  return (
    <div className="space-y-6">
      <Link
        href={`/${slug}/products`}
        className="inline-block text-sm text-muted-foreground underline"
      >
        ← Products
      </Link>

      <div className="flex flex-wrap items-start gap-4">
        {product.imageUrl ? (
          <Image
            src={product.imageUrl}
            alt={product.name}
            width={64}
            height={64}
            className="h-16 w-16 shrink-0 rounded-lg object-cover"
            unoptimized
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
            No img
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold wrap-break-word">{product.name}</h1>
            {product.category && <Badge variant="secondary">{product.category}</Badge>}
          </div>
          <p className="text-sm wrap-break-word text-muted-foreground">
            {product.sku && <>SKU {product.sku} · </>}
            {product.barcode && <>Barcode {product.barcode} · </>}
            {formatStock(stock.onHand, pack)} in stock
            {canViewProfit && <> · stock value {money(stock.value)}</>}
          </p>
        </div>
      </div>

      <form onSubmit={applyRange} className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" type="date" value={f} onChange={(e) => setF(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="to">To</Label>
          <Input id="to" type="date" value={t} onChange={(e) => setT(e.target.value)} />
        </div>
        <Button type="submit" variant={isAllTime ? "outline" : "default"}>
          Apply
        </Button>
        <Button
          type="button"
          variant={isAllTime ? "default" : "outline"}
          onClick={() => router.push(`/${slug}/products/${product.id}?range=all`)}
        >
          All time
        </Button>
      </form>

      <div className={`grid gap-4 sm:grid-cols-2 ${canViewProfit ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        {kpis.map((k) => (
          <Card key={k.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {k.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className={`text-2xl font-bold tabular-nums ${k.className ?? ""}`}>
                {k.value}
              </div>
              {k.hint && <p className="text-xs text-muted-foreground">{k.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {canViewProfit && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">How that profit was reached</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {breakdown.map((r) => (
              <div
                key={r.label}
                className={`flex flex-wrap items-baseline justify-between gap-2 border-b py-2 last:border-0 ${
                  r.strong ? "font-semibold" : ""
                }`}
              >
                <span className="text-sm">
                  {r.label}
                  {r.note && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {r.note}
                    </span>
                  )}
                </span>
                <span
                  className={`tabular-nums ${r.strong ? profitClass(r.value) : r.value < 0 ? "text-muted-foreground" : ""}`}
                >
                  {signed(r.value)}
                </span>
              </div>
            ))}
            <p className="pt-2 text-xs text-muted-foreground">
              Packaging, gifts, the COD fee and the delivery margin are charged to the
              whole order, not to a line, so each is split across the order&apos;s
              products in proportion to their share of its revenue. Ad spend is not
              included — boosting is tracked per campaign, not per product.
            </p>
          </CardContent>
        </Card>
      )}

      {canViewProfit && (totals.cancelledOrders > 0 || totals.refunds > 0 || totals.giftedUnits > 0) && (
        <div className="grid gap-4 sm:grid-cols-3">
          {totals.cancelledOrders > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Cancelled orders
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">
                  {totals.cancelledOrders}
                </div>
                <p className="text-xs text-muted-foreground">
                  cost {money(totals.cancelledCost)} · net after them{" "}
                  <span className={profitClass(totals.netProfitAfterCancellations)}>
                    {money(totals.netProfitAfterCancellations)}
                  </span>
                </p>
              </CardContent>
            </Card>
          )}
          {totals.refunds > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Refunded
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">{money(totals.refunds)}</div>
                <p className="text-xs text-muted-foreground">
                  across {totals.unitsReturned} returned unit(s)
                </p>
              </CardContent>
            </Card>
          )}
          {totals.giftedUnits > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Given as gifts
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">
                  {formatStock(totals.giftedUnits, pack)}
                </div>
                <p className="text-xs text-muted-foreground">
                  worth {money(totals.giftedCost)} — charged to the orders that gave them
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Units & profit by day</CardTitle>
        </CardHeader>
        <CardContent>
          {report.series.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No sales in this range.
            </p>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.series}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="date" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="units" fill="#7c3aed" name="Units" />
                  <Bar dataKey="revenue" fill="#4f46e5" name="Revenue" />
                  {canViewProfit && <Bar dataKey="profit" fill="#16a34a" name="Profit" />}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="orders">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="variants">Variants</TabsTrigger>
          <TabsTrigger value="purchases">Purchases</TabsTrigger>
          <TabsTrigger value="returns">Returns</TabsTrigger>
          <TabsTrigger value="stock">Stock</TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="pt-4">
          <OrdersTable slug={slug} rows={report.orders} canViewProfit={canViewProfit} />
        </TabsContent>

        <TabsContent value="variants" className="pt-4">
          <VariantsTable rows={report.variants} canViewProfit={canViewProfit} pack={pack} />
        </TabsContent>

        <TabsContent value="purchases" className="pt-4 space-y-3">
          {canViewProfit && report.purchases.rows.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {formatStock(report.purchases.quantity, pack)} bought for{" "}
              <span className="font-medium text-foreground tabular-nums">
                {money(report.purchases.spend)}
              </span>{" "}
              in this period.
            </p>
          )}
          <PurchasesTable rows={report.purchases.rows} canViewProfit={canViewProfit} />
        </TabsContent>

        <TabsContent value="returns" className="pt-4">
          <ReturnsTable slug={slug} rows={report.returns} />
        </TabsContent>

        <TabsContent value="stock" className="pt-4">
          <AdjustmentsTable rows={report.adjustments} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OrdersTable({
  slug,
  rows,
  canViewProfit,
}: {
  slug: string;
  rows: OrderRow[];
  canViewProfit: boolean;
}) {
  return (
    <DataTable
      rows={rows}
      rowKey={(o) => o.orderId}
      empty={{ icon: ShoppingBag, title: "No orders with this product" }}
      searchText={(o) => `${o.customer ?? ""} ${o.status} ${o.variants.join(" ")}`}
      searchPlaceholder="Search orders…"
      columns={
        [
          {
            key: "date",
            header: "Date",
            cardTitle: true,
            sortValue: (o) => o.date,
            cell: (o) => o.date,
          },
          {
            key: "customer",
            header: "Customer",
            wrap: true,
            cell: (o) =>
              o.customerId ? (
                <Link
                  href={`/${slug}/customers/${o.customerId}`}
                  className="underline underline-offset-4"
                >
                  {o.customer}
                </Link>
              ) : (
                (o.customer ?? "Walk-in")
              ),
          },
          {
            key: "variant",
            header: "Variant",
            hideable: true,
            wrap: true,
            cell: (o) => o.variants.join(", ") || "—",
          },
          {
            key: "status",
            header: "Status",
            cell: (o) => (
              <Badge variant={o.cancelled ? "destructive" : "secondary"}>{o.status}</Badge>
            ),
          },
          {
            key: "pay",
            header: "Payment",
            hideable: true,
            defaultHidden: true,
            cell: (o) => o.paymentStatus,
          },
          {
            key: "source",
            header: "Channel",
            hideable: true,
            defaultHidden: true,
            cell: (o) => orderSourceLabel(o.source),
          },
          {
            key: "units",
            header: "Units",
            align: "right",
            sortValue: (o) => o.units,
            cell: (o) => (o.cancelled ? <span className="text-muted-foreground">{o.units}</span> : o.units),
          },
          {
            key: "returned",
            header: "Returned",
            align: "right",
            hideable: true,
            cell: (o) => o.returned || "—",
          },
          {
            key: "revenue",
            header: "Revenue",
            align: "right",
            sortValue: (o) => o.revenue,
            cell: (o) => money(o.revenue),
          },
          ...(canViewProfit
            ? [
                {
                  key: "profit",
                  header: "Profit",
                  align: "right" as const,
                  sortValue: (o: OrderRow) => (o.cancelled ? -o.cancelledCost : o.netProfit),
                  cell: (o: OrderRow) =>
                    o.cancelled ? (
                      <span className="text-destructive tabular-nums">
                        {signed(-o.cancelledCost)}
                      </span>
                    ) : (
                      <span className={`tabular-nums ${profitClass(o.netProfit)}`}>
                        {money(o.netProfit)}
                      </span>
                    ),
                },
              ]
            : []),
          {
            key: "links",
            header: "",
            cardFullWidth: true,
            cell: (o: OrderRow) => (
              <span className="flex gap-3">
                <Link
                  href={`/${slug}/sales/orders/${o.orderId}/invoice`}
                  className="text-sm underline underline-offset-4"
                >
                  Invoice
                </Link>
                {canViewProfit && (
                  <Link
                    href={`/${slug}/sales/orders/${o.orderId}/breakdown`}
                    className="text-sm underline underline-offset-4"
                  >
                    Breakdown
                  </Link>
                )}
              </span>
            ),
          },
        ] as Column<OrderRow>[]
      }
    />
  );
}

function VariantsTable({
  rows,
  canViewProfit,
  pack,
}: {
  rows: VariantRow[];
  canViewProfit: boolean;
  pack: number | null;
}) {
  return (
    <DataTable
      rows={rows}
      rowKey={(v) => v.variantId}
      empty={{ icon: Boxes, title: "No variants" }}
      columns={
        [
          { key: "label", header: "Variant", cardTitle: true, cell: (v) => v.label },
          {
            key: "sku",
            header: "SKU",
            hideable: true,
            defaultHidden: true,
            cell: (v) => v.sku ?? "—",
          },
          {
            key: "sold",
            header: "Sold",
            align: "right",
            sortValue: (v) => v.unitsSold,
            cell: (v) => formatStock(v.unitsSold, pack),
          },
          {
            key: "returned",
            header: "Returned",
            align: "right",
            hideable: true,
            cell: (v) => v.unitsReturned || "—",
          },
          {
            key: "revenue",
            header: "Revenue",
            align: "right",
            sortValue: (v) => v.revenue,
            cell: (v) => money(v.revenue),
          },
          ...(canViewProfit
            ? [
                {
                  key: "cogs",
                  header: "COGS",
                  align: "right" as const,
                  hideable: true,
                  cell: (v: VariantRow) => money(v.cogs),
                },
                {
                  key: "gross",
                  header: "Gross margin",
                  align: "right" as const,
                  hideable: true,
                  cell: (v: VariantRow) => money(v.grossMargin),
                },
                {
                  key: "profit",
                  header: "Net profit",
                  align: "right" as const,
                  sortValue: (v: VariantRow) => v.netProfit,
                  cell: (v: VariantRow) => (
                    <span className={`tabular-nums ${profitClass(v.netProfit)}`}>
                      {money(v.netProfit)}
                    </span>
                  ),
                },
              ]
            : []),
          {
            key: "stock",
            header: "In stock",
            align: "right",
            sortValue: (v: VariantRow) => v.stock,
            cell: (v: VariantRow) => formatStock(v.stock, pack),
          },
        ] as Column<VariantRow>[]
      }
    />
  );
}

function PurchasesTable({
  rows,
  canViewProfit,
}: {
  rows: PurchaseRow[];
  canViewProfit: boolean;
}) {
  return (
    <DataTable
      rows={rows}
      rowKey={(p) => p.id}
      empty={{ icon: Truck, title: "No purchases in this period" }}
      columns={
        [
          { key: "date", header: "Date", cardTitle: true, sortValue: (p) => p.date, cell: (p) => p.date },
          { key: "supplier", header: "Supplier", wrap: true, cell: (p) => p.supplier ?? "—" },
          { key: "variant", header: "Variant", cell: (p) => p.variant },
          {
            key: "qty",
            header: "Qty",
            align: "right",
            sortValue: (p) => p.quantity,
            cell: (p) => p.quantity,
          },
          ...(canViewProfit
            ? [
                {
                  key: "unitCost",
                  header: "Unit cost",
                  align: "right" as const,
                  cell: (p: PurchaseRow) => money(p.unitCost),
                },
                {
                  key: "total",
                  header: "Total",
                  align: "right" as const,
                  sortValue: (p: PurchaseRow) => p.total,
                  cell: (p: PurchaseRow) => money(p.total),
                },
              ]
            : []),
          {
            key: "expiry",
            header: "Expiry",
            hideable: true,
            cell: (p: PurchaseRow) => p.expiryDate ?? "—",
          },
        ] as Column<PurchaseRow>[]
      }
    />
  );
}

function ReturnsTable({ slug, rows }: { slug: string; rows: ReturnRow[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      empty={{ icon: RotateCcw, title: "No returns" }}
      columns={
        [
          { key: "date", header: "Date", cardTitle: true, sortValue: (r) => r.date, cell: (r) => r.date },
          { key: "variant", header: "Variant", cell: (r) => r.variant },
          {
            key: "qty",
            header: "Qty",
            align: "right",
            sortValue: (r) => r.quantity,
            cell: (r) => r.quantity,
          },
          {
            key: "refund",
            header: "Refunded",
            align: "right",
            cell: (r) => money(r.refundAmount),
          },
          { key: "reason", header: "Reason", wrap: true, cell: (r) => r.reason ?? "—" },
          {
            key: "order",
            header: "",
            cardFullWidth: true,
            cell: (r: ReturnRow) => (
              <Link
                href={`/${slug}/sales/orders/${r.orderId}/invoice`}
                className="text-sm underline underline-offset-4"
              >
                Order
              </Link>
            ),
          },
        ] as Column<ReturnRow>[]
      }
    />
  );
}

function AdjustmentsTable({ rows }: { rows: AdjustmentRow[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(a) => a.id}
      empty={{ icon: PackageX, title: "No stock adjustments" }}
      columns={
        [
          { key: "date", header: "Date", cardTitle: true, sortValue: (a) => a.date, cell: (a) => a.date },
          { key: "variant", header: "Variant", cell: (a) => a.variant },
          {
            key: "type",
            header: "Type",
            cell: (a) => <Badge variant="outline">{a.type}</Badge>,
          },
          {
            key: "delta",
            header: "Change",
            align: "right",
            sortValue: (a) => a.delta,
            cell: (a) => (
              <span className={a.delta < 0 ? "text-destructive tabular-nums" : "tabular-nums"}>
                {a.delta > 0 ? `+${a.delta}` : a.delta}
              </span>
            ),
          },
          { key: "reason", header: "Reason", wrap: true, cell: (a) => a.reason ?? "—" },
        ] as Column<AdjustmentRow>[]
      }
    />
  );
}
