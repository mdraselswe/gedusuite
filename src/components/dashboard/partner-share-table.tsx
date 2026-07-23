"use client";

import { DataTable, type Column } from "@/components/ui/data-table";
import { Users } from "lucide-react";

type Row = { name: string; percent: number; amount: number };

/** Client wrapper: DataTable takes cell render functions, which can't be
 * passed across the server→client boundary from the dashboard page. */
export function PartnerShareTable({ rows }: { rows: Row[] }) {
  return (
    <DataTable
      rows={rows}
      rowKey={(p) => p.name}
      empty={{ icon: Users, title: "No partners" }}
      columns={
        [
          { key: "name", header: "Partner", cardTitle: true, cell: (p) => p.name },
          { key: "percent", header: "Share %", align: "right", cell: (p) => p.percent.toFixed(2) },
          {
            key: "amount",
            header: "Share amount",
            align: "right",
            cell: (p) => p.amount.toFixed(2),
          },
        ] as Column<Row>[]
      }
    />
  );
}
