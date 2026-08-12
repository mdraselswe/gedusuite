"use client";

import { useState } from "react";
import Link from "next/link";
import { Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { formatMoney as money } from "@/lib/money";
import { Stamp } from "@/components/ui/stamp";
import type { DhakaStamp } from "@/lib/dhaka-time";

type Parcel = DhakaStamp & {
  id: string;
  customerName: string;
  trackingId: string | null;
  status: string;
  cod: number;
  deliveryCost: number;
  codFee: number;
  net: number;
};

export type CourierAccount = {
  id: string;
  name: string;
  /** Delivered, money collected, not yet handed over. */
  holding: Parcel[];
  /** Sent but not delivered — nothing collected yet. */
  inTransit: Parcel[];
  expected: number;
  inTransitValue: number;
};


/**
 * Expected balance against the courier's own figure.
 *
 * The comparison is typed in rather than fetched: couriers don't all have an
 * API, and the number is on screen in their app anyway. What matters is that
 * the difference is computed for you — reading two numbers and subtracting
 * them by hand is exactly the step that gets skipped.
 */
export function CourierReconciliation({
  slug,
  accounts,
}: {
  slug: string;
  accounts: CourierAccount[];
}) {
  const [actual, setActual] = useState<Record<string, string>>({});

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <Truck className="size-6" />
          Nothing with a courier right now.{" "}
          <Link href={`/${slug}/settings/couriers`} className="underline underline-offset-2">
            Set up your couriers
          </Link>{" "}
          so every order prices itself.
        </CardContent>
      </Card>
    );
  }

  const columns: Column<Parcel>[] = [
    {
      key: "date",
      header: "Date",
      cell: (p) => <Stamp date={p.date} time={p.time} entered={p.entered} />,
      sortValue: (p) => p.date,
    },
    {
      key: "customer",
      header: "Customer",
      cardTitle: true,
      wrap: true,
      cell: (p) => (
        <span>
          <span className="inline-flex items-center gap-1.5">
            {p.customerName}
            {/* A cancelled parcel sitting in a list of delivered ones needs
                saying out loud: the customer paid the shipping and sent the
                goods back, so the money is real but the sale isn't. */}
            {p.status === "CANCELLED" && (
              <Badge
                variant="outline"
                className="border-orange-500/40 bg-orange-500/15 font-normal text-orange-800 dark:bg-orange-500/25 dark:text-orange-200"
                title="Cancelled — only what the customer handed over is with the courier"
              >
                Partial
              </Badge>
            )}
          </span>
          {p.trackingId && (
            <span className="block text-xs text-muted-foreground">{p.trackingId}</span>
          )}
        </span>
      ),
    },
    {
      key: "cod",
      header: "COD",
      align: "right",
      sortValue: (p) => p.cod,
      cell: (p) => (
        <span
          className={cn(p.status === "CANCELLED" && "text-orange-800 dark:text-orange-200")}
          title={p.status === "CANCELLED" ? "Collected on a partial delivery" : undefined}
        >
          {money(p.cod)}
        </span>
      ),
    },
    {
      key: "charge",
      header: "Delivery",
      align: "right",
      hideable: true,
      cell: (p) => money(p.deliveryCost),
    },
    {
      key: "codFee",
      header: "COD fee",
      align: "right",
      hideable: true,
      // A zero here on a courier that charges a percentage means the order was
      // entered before its rates were set up — worth spotting, not hiding.
      cell: (p) => (
        <span className={cn(p.codFee === 0 && "text-muted-foreground")}>{money(p.codFee)}</span>
      ),
    },
    {
      key: "net",
      header: "You get",
      align: "right",
      sortValue: (p) => p.net,
      cell: (p) => <span className="font-medium tabular-nums">{money(p.net)}</span>,
    },
  ];

  return (
    <div className="space-y-6">
      {accounts.map((a) => {
        const typed = actual[a.id];
        const actualNum = typed === undefined || typed === "" ? null : Number(typed);
        const diff = actualNum === null ? null : Math.round((actualNum - a.expected) * 100) / 100;

        return (
          <Card key={a.id}>
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">{a.name}</CardTitle>
                <Link
                  href={`/${slug}/sales/orders`}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  open orders
                </Link>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-muted-foreground">
                    They should be holding
                  </div>
                  <div className="text-2xl font-bold tabular-nums">{money(a.expected)}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.holding.filter((p) => p.status !== "CANCELLED").length} delivered
                    parcel(s)
                    {a.holding.some((p) => p.status === "CANCELLED") &&
                      ` + ${a.holding.filter((p) => p.status === "CANCELLED").length} partial`}
                    , COD less their charges
                  </div>
                  {/* The rule this page runs on, said once where it matters:
                      "paid" happens when the rider takes the cash, which is
                      the moment the courier starts holding it. */}
                  <div className="mt-1 text-xs text-muted-foreground">
                    Counts every delivered parcel until its cash is marked deposited —
                    do that when the courier actually pays out.
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`actual-${a.id}`} className="text-xs text-muted-foreground">
                    Balance in their app
                  </Label>
                  <Input
                    id={`actual-${a.id}`}
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="Type it to compare"
                    value={typed ?? ""}
                    onChange={(e) => setActual({ ...actual, [a.id]: e.target.value })}
                  />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Difference</div>
                  {diff === null ? (
                    <div className="text-2xl font-bold text-muted-foreground">—</div>
                  ) : (
                    <>
                      <div
                        className={cn(
                          "text-2xl font-bold tabular-nums",
                          Math.abs(diff) < 1
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-destructive",
                        )}
                      >
                        {diff > 0 ? "+" : ""}
                        {money(diff)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {Math.abs(diff) < 1
                          ? "Matches — nothing unexplained."
                          : diff < 0
                            ? "They hold less than expected: a charge you don't have — a return, or a rate that isn't what's set up."
                            : "They hold more than expected: a parcel's cost is set too high here."}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {a.inTransit.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Plus {a.inTransit.length} parcel(s) still on the way, worth{" "}
                  <span className="font-medium tabular-nums">{money(a.inTransitValue)}</span> —
                  not in the balance above, because nothing has been collected yet.
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <DataTable
                rows={a.holding}
                rowKey={(p) => p.id}
                empty={{ title: "Nothing delivered and unpaid" }}
                columns={columns}
              />
              {a.inTransit.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Still on the way</div>
                  <DataTable
                    rows={a.inTransit}
                    rowKey={(p) => p.id}
                    empty={{ title: "Nothing in transit" }}
                    columns={columns.filter((c) => c.key !== "net")}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
