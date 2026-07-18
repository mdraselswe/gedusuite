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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Report } from "@/lib/reports";


export function ReportView({
  slug,
  report,
  from,
  to,
}: {
  slug: string;
  report: Report;
  from: string;
  to: string;
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
      ["GeduSuite report", `${from} to ${to}`],
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
    doc.setFontSize(16);
    doc.text("GeduSuite report", 14, 18);
    doc.setFontSize(10);
    doc.text(`${from} to ${to}`, 14, 25);

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead className="text-right">Share %</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.partnerShares.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="text-right">{p.percent.toFixed(2)}</TableCell>
                    <TableCell className="text-right font-medium">{p.amount.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ProductTable({ rows, empty }: { rows: Report["products"]; empty: string }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Revenue</TableHead>
          <TableHead className="text-right">Profit</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((p) => (
          <TableRow key={p.productId}>
            <TableCell className="font-medium">{p.name}</TableCell>
            <TableCell className="text-right">{p.qty}</TableCell>
            <TableCell className="text-right">{p.revenue.toFixed(2)}</TableCell>
            <TableCell className="text-right">{p.profit.toFixed(2)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
