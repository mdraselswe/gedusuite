"use client";

import { useState } from "react";
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
import { BarChart3, Users } from "lucide-react";
import type { Report } from "@/lib/reports";


export function ReportView({
  slug,
  report,
  from,
  to,
  workspaceName,
  logoUrl,
}: {
  slug: string;
  report: Report;
  from: string;
  to: string;
  workspaceName: string;
  logoUrl: string | null;
}) {
  const router = useRouter();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  const sold = report.products.filter((p) => p.qty > 0);
  const best = sold.slice(0, 5);
  const slow = [...report.products].sort((a, b) => a.qty - b.qty).slice(0, 5);

  function applyRange(e: React.FormEvent) {
    e.preventDefault();
    router.push(`/${slug}/reports?from=${f}&to=${t}`);
  }

  async function exportExcel() {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const summary = XLSX.utils.aoa_to_sheet([
      [workspaceName, `${from} to ${to}`],
      [],
      ["Revenue", report.kpis.revenue],
      ["Net profit", report.kpis.profit],
      ["Orders", report.kpis.orders],
      ["Avg order value", report.kpis.avgOrder],
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
    XLSX.writeFile(wb, `gedusuite-report-${from}_${to}.xlsx`);
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
    doc.text(`${from} to ${to}`, titleX, 21);

    autoTable(doc, {
      startY: 32,
      head: [["Metric", "Value"]],
      body: [
        ["Revenue", report.kpis.revenue.toFixed(2)],
        ["Net profit", report.kpis.profit.toFixed(2)],
        ["Orders", String(report.kpis.orders)],
        ["Avg order value", report.kpis.avgOrder.toFixed(2)],
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
        head: [["Partner", "Share %", "Amount"]],
        body: report.partnerShares.map((p) => [
          p.name,
          p.percent.toFixed(2),
          p.amount.toFixed(2),
        ]),
      });
    }
    doc.save(`gedusuite-report-${from}_${to}.pdf`);
  }

  const kpis: [string, string | number][] = [
    ["Revenue", report.kpis.revenue.toFixed(2)],
    ["Net profit", report.kpis.profit.toFixed(2)],
    ["Orders", report.kpis.orders],
    ["Avg order", report.kpis.avgOrder.toFixed(2)],
  ];

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
          <Button type="submit">Apply</Button>
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
            <ProductTable rows={best} empty="No sales yet." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Slow-moving</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductTable rows={slow} empty="No products yet." />
          </CardContent>
        </Card>
      </div>

      {report.partnerShares.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Partner profit share</CardTitle>
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
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (p) => p.amount.toFixed(2),
                  },
                ] as Column<Report["partnerShares"][number]>[]
              }
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ProductTable({ rows, empty }: { rows: Report["products"]; empty: string }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(p) => p.productId}
      empty={{ icon: BarChart3, title: empty }}
      columns={
        [
          { key: "name", header: "Product", cardTitle: true, cell: (p) => p.name },
          { key: "qty", header: "Qty", align: "right", cell: (p) => p.qty },
          {
            key: "revenue",
            header: "Revenue",
            align: "right",
            cell: (p) => p.revenue.toFixed(2),
          },
          {
            key: "profit",
            header: "Profit",
            align: "right",
            cell: (p) => p.profit.toFixed(2),
          },
        ] as Column<Report["products"][number]>[]
      }
    />
  );
}
