"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ShoppingBag } from "lucide-react";
import { Money } from "@/components/ui/money";
import { Stamp } from "@/components/ui/stamp";
import type { DhakaStamp } from "@/lib/dhaka-time";

type Row = DhakaStamp & {
  id: string;
  status: string;
  paymentStatus: string;
  itemCount: number;
  customerTotal: number;
  netProfit: number;
};

/** Client wrapper: DataTable takes cell render functions, which can't be
 * passed across the server→client boundary from the customer detail page. */
export function CustomerOrdersTable({
  slug,
  rows,
  canViewProfit,
}: {
  slug: string;
  rows: Row[];
  canViewProfit: boolean;
}) {
  return (
    <DataTable
      rows={rows}
      rowKey={(o) => o.id}
      colorGroupBy={(o) => o.date}
      colorToggleLabel="Color by date"
      empty={{ icon: ShoppingBag, title: "No orders yet" }}
      columns={
        [
          {
            key: "date",
            header: "Date",
            cardTitle: true,
            cell: (o) => <Stamp date={o.date} time={o.time} entered={o.entered} />,
          },
          {
            key: "status",
            header: "Status",
            cell: (o) => <Badge variant="secondary">{o.status}</Badge>,
          },
          { key: "payment", header: "Payment", cell: (o) => o.paymentStatus },
          { key: "items", header: "Items", align: "right", cell: (o) => o.itemCount },
          {
            key: "total",
            header: "Total",
            align: "right",
            cell: (o) => <Money value={o.customerTotal} />,
          },
          ...(canViewProfit
            ? [
                {
                  key: "profit",
                  header: "Profit",
                  align: "right" as const,
                  // Marked on a cancelled row: nothing was sold, so the figure
                  // is what the cancellation left, not a trading margin.
                  cell: (o: Row) =>
                    o.status === "CANCELLED" ? (
                      <span
                        className="text-muted-foreground"
                        title="Cancelled: collected on a partial delivery, less the courier's return charge and any gift. Nothing was sold."
                      >
                        <Money value={o.netProfit} />
                      </span>
                    ) : (
                      <Money value={o.netProfit} />
                    ),
                },
              ]
            : []),
          {
            key: "links",
            header: "",
            cardFullWidth: true,
            cell: (o: Row) => (
              <span className="flex gap-3">
                <Link
                  href={`/${slug}/sales/orders/${o.id}/invoice`}
                  className="text-sm underline underline-offset-4"
                >
                  Invoice
                </Link>
                {canViewProfit && (
                  <Link
                    href={`/${slug}/sales/orders/${o.id}/breakdown`}
                    className="text-sm underline underline-offset-4"
                  >
                    Breakdown
                  </Link>
                )}
              </span>
            ),
          },
        ] as Column<Row>[]
      }
    />
  );
}
