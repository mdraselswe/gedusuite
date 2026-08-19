"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { orderSourceLabel } from "@/lib/order-source";
import { cn } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { InfoNote } from "@/components/ui/info-note";
import { FigureList, FigureRow } from "@/components/ui/figure-list";
import { formatMoney, toneForBalance } from "@/lib/money";
import { BarChart3, MapPin, Users, Wallet } from "lucide-react";
import type { Report } from "@/lib/reports";

/**
 * Below this many settled parcels a district's cancel rate is one refusal away
 * from any figure you like, so the percentage is shown muted. The count next to
 * it is still real and still worth reading.
 */
const MIN_SETTLED_FOR_RATE = 5;

function formatMethod(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}


export function ReportView({
  slug,
  report,
  from,
  to,
  isAllTime,
  workspaceName,
  logoUrl,
}: {
  slug: string;
  report: Report;
  from: string;
  to: string;
  isAllTime: boolean;
  workspaceName: string;
  logoUrl: string | null;
}) {
  const router = useRouter();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  // Do the partners' own percents already total 100? When they don't,
  // splitByShare normalizes and the table says so rather than showing two
  // unexplained percentages.
  const sharesNormalized = report.partnerShares.every(
    (p) => p.percent.toFixed(2) === p.effectivePercent.toFixed(2),
  );

  const sold = report.products.filter((p) => p.qty > 0);
  const best = sold.slice(0, 5);
  const slow = [...report.products].sort((a, b) => a.qty - b.qty).slice(0, 5);

  // Used in export filenames/headers — a real "from to" range normally, or a
  // plain label once "All time" is selected (actual dates would be misleading).
  const period = isAllTime ? "All time" : `${from} to ${to}`;

  function applyRange(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/${slug}/reports?from=${f}&to=${t}`);
  }

  function viewAllTime() {
    router.push(`/${slug}/reports?range=all`);
  }

  async function exportExcel() {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const summary = XLSX.utils.aoa_to_sheet([
      [workspaceName, period],
      [],
      ["Revenue", report.kpis.revenue],
      ["Order profit", report.kpis.profit],
      ["Ad spend", report.kpis.adSpend],
      ["Internal purchases", report.kpis.internalPurchaseSpend],
      ["Other partner expenses", report.kpis.miscExpense],
      ["Damaged / lost stock", report.kpis.stockLoss],
      ["Operating expenses", report.kpis.operatingExpenses],
      ["Net profit", report.kpis.netProfit],
      ["Orders", report.kpis.orders],
      ["Avg order value", report.kpis.avgOrder],
      ["Cancelled orders", report.kpis.cancelledOrders],
      ["Cancelled cost", report.kpis.cancelledCost],
      ["Parcels sent back", report.returns.sentBack],
      ["Parcels received back", report.returns.received],
      ["Parcels still with the courier", report.returns.stillOut],
      ["Parcels never returned", report.returns.lost],
      ["Value never returned", report.returns.lostCost],
    ]);
    XLSX.utils.book_append_sheet(wb, summary, "Summary");
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(report.series),
      "Sales by day",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        report.products.map((p) => ({
          Product: p.name,
          Qty: p.qty,
          Revenue: p.revenue,
          Profit: p.profit,
        })),
      ),
      "Products",
    );
    if (report.partnerShares.length) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(report.partnerShares),
        "Partner shares",
      );
    }
    if (report.bySource.length) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          report.bySource.map((s) => ({
            Channel: orderSourceLabel(s.source),
            Orders: s.orders,
            Revenue: s.revenue,
            Profit: s.profit,
            Cancelled: s.cancelledOrders,
            "Cancel rate %": s.cancelRate === null ? "" : +(s.cancelRate * 100).toFixed(1),
            "Cancelled cost": s.cancelledCost,
          })),
        ),
        "Order sources",
      );
    }
    if (report.byDistrict.length) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          report.byDistrict.map((d) => ({
            District: d.district ?? "Not tagged",
            Orders: d.orders,
            Delivered: d.delivered,
            Cancelled: d.cancelled,
            "Still travelling": d.inFlight,
            // Out of settled parcels, same as the table — an export that
            // computed it differently would be a second answer to one question.
            "Cancel rate %": d.cancelRate === null ? "" : +(d.cancelRate * 100).toFixed(1),
            Revenue: d.revenue,
            "Cancelled cost": d.cancelledCost,
          })),
        ),
        "Districts",
      );
    }
    if (report.collectedByMethod.length) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          report.collectedByMethod.map((m) => ({
            Method: formatMethod(m.method),
            Orders: m.orders,
            Amount: m.amount,
          })),
        ),
        "Collected by method",
      );
    }
    XLSX.writeFile(wb, `gedusuite-report-${isAllTime ? "all-time" : `${from}_${to}`}.xlsx`);
  }

  async function exportPdf() {
    const { jsPDF } = await import("jspdf");
    const autoTable = (await import("jspdf-autotable")).default;
    const doc = new jsPDF();

    // Standard header logo, same as every other place it's used: fixed
    // height, width follows from its own aspect ratio (jsPDF has no way to
    // know that itself, so it's measured client-side before addImage).
    let titleX = 14;
    if (logoUrl) {
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("Invalid logo"));
        img.src = logoUrl;
      }).catch(() => null);
      if (dims) {
        const targetH = 12;
        const targetW = (dims.w / dims.h) * targetH;
        doc.addImage(logoUrl, "PNG", 14, 6, targetW, targetH);
        titleX = 14 + targetW + 4;
      }
    }

    doc.setFontSize(16);
    doc.text(workspaceName, titleX, 15);
    doc.setFontSize(10);
    doc.text(period, titleX, 21);

    autoTable(doc, {
      startY: 32,
      head: [["Metric", "Value"]],
      body: [
        ["Revenue", report.kpis.revenue.toFixed(2)],
        ["Order profit", report.kpis.profit.toFixed(2)],
        ["Ad spend", report.kpis.adSpend.toFixed(2)],
        ["Internal purchases", report.kpis.internalPurchaseSpend.toFixed(2)],
        ["Other partner expenses", report.kpis.miscExpense.toFixed(2)],
        ["Damaged / lost stock", report.kpis.stockLoss.toFixed(2)],
        ["Operating expenses", report.kpis.operatingExpenses.toFixed(2)],
        ["Net profit", report.kpis.netProfit.toFixed(2)],
        ["Orders", String(report.kpis.orders)],
        ["Avg order value", report.kpis.avgOrder.toFixed(2)],
        ["Cancelled orders", String(report.kpis.cancelledOrders)],
        ["Cancelled cost", report.kpis.cancelledCost.toFixed(2)],
        // Only worth a row once a parcel has actually been sent back — on a
        // range with none, four zeroes say nothing and take four lines.
        ...(report.returns.sentBack > 0
          ? [
              ["Parcels sent back", String(report.returns.sentBack)],
              ["Parcels received back", String(report.returns.received)],
              ["Parcels still with the courier", String(report.returns.stillOut)],
              ["Parcels never returned", String(report.returns.lost)],
              ["Value never returned", report.returns.lostCost.toFixed(2)],
            ]
          : []),
      ],
    });
    autoTable(doc, {
      head: [["Product", "Qty", "Revenue", "Profit"]],
      body: report.products.map((p) => [
        p.name,
        String(p.qty),
        p.revenue.toFixed(2),
        p.profit.toFixed(2),
      ]),
    });
    if (report.partnerShares.length) {
      autoTable(doc, {
        head: [["Partner", "Share %", "Effective %", "Amount"]],
        body: report.partnerShares.map((p) => [
          p.name,
          p.percent.toFixed(2),
          p.effectivePercent.toFixed(2),
          p.amount.toFixed(2),
        ]),
      });
    }
    if (report.bySource.length) {
      autoTable(doc, {
        head: [["Came from", "Orders", "Revenue", "Profit", "Cancelled"]],
        body: report.bySource.map((s) => [
          orderSourceLabel(s.source),
          String(s.orders),
          s.revenue.toFixed(2),
          s.profit.toFixed(2),
          s.cancelledOrders === 0
            ? "—"
            : `${s.cancelledOrders} (${((s.cancelRate ?? 0) * 100).toFixed(0)}%)`,
        ]),
      });
    }
    if (report.byDistrict.length) {
      autoTable(doc, {
        head: [["District", "Orders", "Delivered", "On the way", "Cancelled"]],
        body: report.byDistrict.map((d) => [
          d.district ?? "Not tagged",
          String(d.orders),
          String(d.delivered),
          String(d.inFlight),
          d.cancelled === 0
            ? "—"
            : `${d.cancelled} (${((d.cancelRate ?? 0) * 100).toFixed(0)}%)`,
        ]),
      });
    }
    if (report.collectedByMethod.length) {
      autoTable(doc, {
        head: [["Payment method", "Orders", "Amount collected"]],
        body: report.collectedByMethod.map((m) => [
          formatMethod(m.method),
          String(m.orders),
          m.amount.toFixed(2),
        ]),
      });
    }
    doc.save(`gedusuite-report-${isAllTime ? "all-time" : `${from}_${to}`}.pdf`);
  }

  const kpis: [string, string | number][] = [
    ["Revenue", report.kpis.revenue.toFixed(2)],
    ["Order profit", report.kpis.profit.toFixed(2)],
    ["Operating expenses", report.kpis.operatingExpenses.toFixed(2)],
    // Order profit less everything it took to run the shop over this range —
    // the figure partner shares are paid on, so it leads rather than hides
    // behind "profit after ads", which only ever covered one of the three.
    ["Net profit", report.kpis.netProfit.toFixed(2)],
    ["Orders", report.kpis.orders],
    ["Avg order", report.kpis.avgOrder.toFixed(2)],
  ];

  const expenseLines: [string, number][] = [
    ["Ad spend", report.kpis.adSpend],
    ["Internal purchases", report.kpis.internalPurchaseSpend],
    ["Other partner expenses", report.kpis.miscExpense],
    ["Damaged / lost stock", report.kpis.stockLoss],
  ];

  // Kept out of the KPI grid above: it's a loss, not a headline figure, and
  // the count alone would read like an order count if it sat beside "Orders".
  const cancelled = report.kpis.cancelledOrders > 0 && (
    <InfoNote
      title={
        <>
          {report.kpis.cancelledOrders} cancelled order(s) cost{" "}
          <Money value={report.kpis.cancelledCost} tone="negative" />
        </>
      }
    >
      <p>
        Packaging, gifts and courier return charges on parcels that came back — already
        subtracted from order profit above. Nothing was sold, so revenue and the order
        count leave them out.
      </p>
    </InfoNote>
  );

  // The other half of a cancellation, and the half no money figure answers:
  // the charge is paid whether or not the parcel ever turns up. A courier that
  // keeps one parcel in ten is a cost that used to be invisible — the goods
  // simply stayed on the shelf as stock nobody could find.
  const returnLegs = report.returns.sentBack > 0 && (
    <InfoNote
      title={
        <>
          {report.returns.received} of {report.returns.sentBack} returned parcel(s) came
          back
          {report.returns.lost > 0 && (
            <>
              {" "}
              · {report.returns.lost} never did (
              <Money value={report.returns.lostCost} tone="negative" />)
            </>
          )}
        </>
      }
    >
      <p>
        Cancelled parcels that had to travel back from the courier.
        {report.returns.stillOut > 0 && (
          <> {report.returns.stillOut} still in transit — no verdict on those yet.</>
        )}
        {report.returns.lossRate !== null && (
          <>
            {" "}
            Of the ones settled either way, {(report.returns.lossRate * 100).toFixed(0)}%
            never came back.
          </>
        )}
      </p>
      <p>
        What the lost goods cost is already inside &quot;damaged / lost stock&quot; above —
        shown here to say which courier trips it came from, not to be subtracted twice.
      </p>
    </InfoNote>
  );

  // What the shop cost to run over this range. Broken out rather than left as
  // one "operating expenses" figure: a partner asking why net profit is below
  // order profit should be able to read the answer instead of asking.
  const expenses = report.kpis.operatingExpenses !== 0 && (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Order profit to net profit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <FigureList>
          <FigureRow label="Order profit" value={report.kpis.profit} />
          {expenseLines
            .filter(([, value]) => value !== 0)
            .map(([label, value]) => (
              <FigureRow key={label} label={label} value={-value} tone="muted" />
            ))}
          <FigureRow
            label="Net profit"
            value={report.kpis.netProfit}
            tone={toneForBalance(report.kpis.netProfit)}
            total
          />
          {report.kpis.prepaidExpenses > 0 && (
            <FigureRow
              label="Paid for but not yet expensed"
              hint="spread costs with time left to run — the cash is already gone"
              value={report.kpis.prepaidExpenses}
              tone="muted"
              sub
            />
          )}
        </FigureList>
        <InfoNote title="When a cost lands in this period">
          <p>
            Expenses land in the period they were paid for, unless a purchase says how
            many months it covers — then it&apos;s charged across those months instead.
          </p>
        </InfoNote>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <form onSubmit={applyRange} className="flex items-end gap-2">
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
            onClick={viewAllTime}
          >
            All time
          </Button>
        </form>
        <div className="flex gap-2">
          <Button variant="outline" onClick={exportExcel}>
            Export Excel
          </Button>
          <Button variant="outline" onClick={exportPdf}>
            Export PDF
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        {kpis.map(([label, val]) => (
          <Card key={label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{val}</CardContent>
          </Card>
        ))}
      </div>

      {cancelled}
      {returnLegs}
      {expenses}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sales & profit by day</CardTitle>
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
                  <Bar dataKey="sales" fill="#4f46e5" name="Sales" />
                  <Bar dataKey="profit" fill="#16a34a" name="Profit" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Best-selling</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductTable slug={slug} rows={best} empty="No sales yet." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Slow-moving</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductTable slug={slug} rows={slow} empty="No products yet." />
          </CardContent>
        </Card>
      </div>

      {report.partnerShares.length > 0 && (
        <Card>
          <CardHeader>
            {/* This range's earnings split by share — not an amount owed.
                Whether any of it is still to be paid is the treasury page's
                question, which nets off every distribution ever made. */}
            <CardTitle className="text-base">
              Partner profit share — what this period earned
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={report.partnerShares}
              rowKey={(p) => p.name}
              empty={{ icon: Users, title: "No partners" }}
              columns={
                [
                  { key: "name", header: "Partner", cardTitle: true, cell: (p) => p.name },
                  {
                    key: "percent",
                    header: "Share %",
                    align: "right",
                    cell: (p) => p.percent.toFixed(2),
                  },
                  // Only when normalization actually moved it — otherwise the
                  // column just repeats the one before it.
                  ...(sharesNormalized
                    ? []
                    : [
                        {
                          key: "effective",
                          header: "Effective %",
                          align: "right" as const,
                          cell: (p: Report["partnerShares"][number]) =>
                            p.effectivePercent.toFixed(2),
                        },
                      ]),
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (p) => <Money value={p.amount} />,
                  },
                ] as Column<Report["partnerShares"][number]>[]
              }
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Calculated on net profit — order profit less this period&apos;s ad spend,
              internal purchases and other expenses.
              {!sharesNormalized &&
                " The shares don't total 100%, so each is paid their percent of the total in use."}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where orders came from</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={report.bySource}
            rowKey={(s) => s.source ?? "__unset__"}
            empty={{ icon: Wallet, title: "No orders in this range" }}
            columns={
              [
                {
                  key: "source",
                  header: "Channel",
                  cardTitle: true,
                  cell: (s) => (
                    // Untagged orders are called out, not quietly dashed: the
                    // report is only as complete as the tagging.
                    <span className={cn(!s.source && "text-amber-700 dark:text-amber-400")}>
                      {orderSourceLabel(s.source)}
                    </span>
                  ),
                },
                { key: "orders", header: "Orders", align: "right", cell: (s) => s.orders },
                {
                  key: "revenue",
                  header: "Revenue",
                  align: "right",
                  cell: (s) => <Money value={s.revenue} className="font-medium" />,
                },
                {
                  key: "profit",
                  header: "Profit",
                  align: "right",
                  cell: (s) => <Money value={s.profit} />,
                },
                {
                  key: "cancelRate",
                  header: "Cancelled",
                  align: "right",
                  // A channel can look strong on revenue and still be the
                  // worst one to spend on, if half of what it sends comes
                  // back. Amber past a fifth — that's where the packaging and
                  // courier charges start to matter more than the sales.
                  cell: (s) =>
                    s.cancelledOrders === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className={cn(
                          "tabular-nums",
                          (s.cancelRate ?? 0) >= 0.2 && "text-amber-700 dark:text-amber-400",
                        )}
                        title={`${formatMoney(s.cancelledCost)} lost on packaging, gifts and courier returns`}
                      >
                        {s.cancelledOrders} · {((s.cancelRate ?? 0) * 100).toFixed(0)}%
                      </span>
                    ),
                },
              ] as Column<Report["bySource"][number]>[]
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where parcels went</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={report.byDistrict}
            rowKey={(d) => d.district ?? "__unset__"}
            empty={{ icon: MapPin, title: "No orders in this range" }}
            columns={
              [
                {
                  key: "district",
                  header: "District",
                  cardTitle: true,
                  cell: (d) => (
                    // Same treatment as an untagged channel: a gap to close,
                    // not a place.
                    <span className={cn(!d.district && "text-amber-700 dark:text-amber-400")}>
                      {d.district ?? "Not tagged"}
                    </span>
                  ),
                },
                { key: "orders", header: "Orders", align: "right", cell: (d) => d.orders },
                {
                  key: "delivered",
                  header: "Delivered",
                  align: "right",
                  cell: (d) => (
                    <span className="tabular-nums">
                      {d.delivered}
                      {d.inFlight > 0 && (
                        <span
                          className="text-muted-foreground"
                          title={`${d.inFlight} still on the way — no verdict yet`}
                        >
                          {" "}
                          +{d.inFlight}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: "revenue",
                  header: "Revenue",
                  align: "right",
                  cell: (d) => <Money value={d.revenue} className="font-medium" />,
                },
                {
                  key: "cancelRate",
                  header: "Cancelled",
                  align: "right",
                  // The rate is out of settled parcels only, so it answers "of
                  // the ones that got an answer, how many came back". Below a
                  // handful of settled parcels it is one refusal away from any
                  // number at all, so it is shown muted rather than in amber —
                  // the count is real, the percentage is not yet worth acting
                  // on.
                  cell: (d) => {
                    if (d.cancelled === 0) {
                      return <span className="text-muted-foreground">—</span>;
                    }
                    const settled = d.delivered + d.cancelled;
                    const thin = settled < MIN_SETTLED_FOR_RATE;
                    return (
                      <span
                        className={cn(
                          "tabular-nums",
                          thin
                            ? "text-muted-foreground"
                            : (d.cancelRate ?? 0) >= 0.2 && "text-amber-700 dark:text-amber-400",
                        )}
                        title={
                          thin
                            ? `Only ${settled} settled parcel(s) here — the count is real, the percentage is noise. ${formatMoney(d.cancelledCost)} lost on packaging, gifts and courier returns`
                            : `${formatMoney(d.cancelledCost)} lost on packaging, gifts and courier returns`
                        }
                      >
                        {d.cancelled} · {((d.cancelRate ?? 0) * 100).toFixed(0)}%
                      </span>
                    );
                  },
                },
              ] as Column<Report["byDistrict"][number]>[]
            }
          />
          <p className="mt-3 text-xs text-muted-foreground">
            Cancel rate is out of parcels that settled — delivered or cancelled. Ones still
            travelling are shown as <span className="tabular-nums">+n</span> beside delivered
            and left out of the rate. Percentages in grey have fewer than{" "}
            {MIN_SETTLED_FOR_RATE} settled parcels behind them: the count is real, the
            percentage is not yet.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Collected by payment method</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            rows={report.collectedByMethod}
            rowKey={(m) => m.method}
            empty={{ icon: Wallet, title: "Nothing collected in this range" }}
            columns={
              [
                {
                  key: "method",
                  header: "Method",
                  cardTitle: true,
                  cell: (m) => formatMethod(m.method),
                },
                { key: "orders", header: "Orders", align: "right", cell: (m) => m.orders },
                {
                  key: "amount",
                  header: "Amount collected",
                  align: "right",
                  cell: (m) => <Money value={m.amount} className="font-medium" />,
                },
              ] as Column<Report["collectedByMethod"][number]>[]
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ProductTable({
  slug,
  rows,
  empty,
}: {
  slug: string;
  rows: Report["products"];
  empty: string;
}) {
  return (
    <DataTable
      rows={rows}
      rowKey={(p) => p.productId}
      empty={{ icon: BarChart3, title: empty }}
      columns={
        [
          {
            key: "name",
            header: "Product",
            cardTitle: true,
            wrap: true,
            // The figures here are gross margin only; the product page breaks
            // the same sale down to net profit.
            cell: (p) => (
              <Link
                href={`/${slug}/products/${p.productId}`}
                className="underline-offset-4 hover:underline"
              >
                {p.name}
              </Link>
            ),
          },
          { key: "qty", header: "Qty", align: "right", cell: (p) => p.qty },
          {
            key: "revenue",
            header: "Revenue",
            align: "right",
            cell: (p) => <Money value={p.revenue} />,
          },
          {
            key: "profit",
            header: "Profit",
            align: "right",
            cell: (p) => <Money value={p.profit} />,
          },
        ] as Column<Report["products"][number]>[]
      }
    />
  );
}
