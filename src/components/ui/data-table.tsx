import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right";
  /** Hide the label in the mobile card (e.g. an actions row). */
  cardFullWidth?: boolean;
  /** Emphasize as the card's title line on mobile. */
  cardTitle?: boolean;
};

/**
 * Responsive data list (TECH_SPEC §10): a real table at md+ and a stacked
 * card layout below md — never a horizontally scrolling table on a phone.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: { icon?: LucideIcon; title: string; description?: string };
}) {
  if (rows.length === 0) {
    return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />;
  }

  return (
    <>
      {/* Desktop / tablet: table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.key} className={c.align === "right" ? "text-right" : undefined}>
                  {c.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>
                {columns.map((c) => (
                  <TableCell
                    key={c.key}
                    className={c.align === "right" ? "text-right" : undefined}
                  >
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-3 md:hidden">
        {rows.map((row) => (
          <div key={rowKey(row)} className="rounded-lg border p-3">
            {columns.map((c) => {
              const value = c.cell(row);
              if (c.cardFullWidth) {
                return (
                  <div key={c.key} className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                    {value}
                  </div>
                );
              }
              if (c.cardTitle) {
                return (
                  <div key={c.key} className="mb-1 font-medium">
                    {value}
                  </div>
                );
              }
              return (
                <div
                  key={c.key}
                  className="flex items-center justify-between gap-3 py-0.5 text-sm"
                >
                  <span className="shrink-0 text-muted-foreground">{c.header}</span>
                  <span className={cn("min-w-0", c.align === "right" && "text-right")}>
                    {value}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
