"use client";

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Columns3, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  /** Allow the cell text to wrap (table cells are nowrap by default). */
  wrap?: boolean;
  /** Makes this column a sort option in the built-in toolbar. */
  sortValue?: (row: T) => number | string;
  /** Shows this column in the toolbar's Columns show/hide menu. */
  hideable?: boolean;
  /** Start hidden (only meaningful with hideable). */
  defaultHidden?: boolean;
  /** Menu/sort label when `header` isn't a plain string. */
  label?: string;
  /** Hide the label in the mobile card (e.g. an actions row). */
  cardFullWidth?: boolean;
  /** Emphasize as the card's title line on mobile. */
  cardTitle?: boolean;
};

const DEFAULT_SORT = "__default__";

/**
 * Responsive data list (TECH_SPEC §10): a real table at md+ and a stacked
 * card layout below md — never a horizontally scrolling page on a phone.
 *
 * Headers are sticky by default (the table gets its own bounded scroll area,
 * since position:sticky is only reliable against the element's own scroll
 * container). Rows paginate client-side past `pageSize`.
 *
 * Built-in toolbar (client-side, operates on the rows passed in):
 * - search box — enabled by the `searchText` prop
 * - sort dropdown — enabled by columns carrying `sortValue`
 * - Columns show/hide menu — enabled by columns marked `hideable`
 * Pages with server-driven toolbars (orders, purchases) simply don't pass
 * these and keep their own controls.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  stickyHeader = true,
  pageSize = 50,
  searchText,
  searchPlaceholder = "Search…",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty: { icon?: LucideIcon; title: string; description?: string };
  stickyHeader?: boolean;
  pageSize?: number;
  /** Text a row is matched against by the toolbar search box. */
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
}) {
  const [pageState, setPageState] = useState(1);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState(DEFAULT_SORT); // "<colKey>:asc|desc"
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(columns.filter((c) => c.hideable && c.defaultHidden).map((c) => c.key)),
  );

  const sortableCols = columns.filter((c) => c.sortValue);
  const hideableCols = columns.filter((c) => c.hideable);
  const hasToolbar = !!searchText || sortableCols.length > 0 || hideableCols.length > 0;

  const labelOf = (c: Column<T>) =>
    c.label ?? (typeof c.header === "string" && c.header ? c.header : c.key);

  const visibleColumns = columns.filter((c) => !c.hideable || !hidden.has(c.key));

  const processed = useMemo(() => {
    let out = rows;
    const q = query.trim().toLowerCase();
    if (q && searchText) {
      out = out.filter((r) => searchText(r).toLowerCase().includes(q));
    }
    if (sortKey !== DEFAULT_SORT) {
      const [colKey, dir] = sortKey.split(":");
      const col = columns.find((c) => c.key === colKey);
      if (col?.sortValue) {
        const sv = col.sortValue;
        out = [...out].sort((a, b) => {
          const va = sv(a);
          const vb = sv(b);
          const cmp =
            typeof va === "number" && typeof vb === "number"
              ? va - vb
              : String(va).localeCompare(String(vb));
          return dir === "desc" ? -cmp : cmp;
        });
      }
    }
    return out;
  }, [rows, query, sortKey, columns, searchText]);

  const totalPages = Math.max(1, Math.ceil(processed.length / pageSize));
  const page = Math.min(pageState, totalPages); // clamp if rows shrank (filters)
  const pageRows =
    totalPages > 1 ? processed.slice((page - 1) * pageSize, page * pageSize) : processed;

  function toggleColumn(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const toolbar = hasToolbar && (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {searchText && (
        <div className="relative w-full max-w-xs">
          <Input
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPageState(1);
            }}
            className={query ? "pr-8" : undefined}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                setPageState(1);
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      )}
      {sortableCols.length > 0 && (
        <Select value={sortKey} onValueChange={(v) => v && setSortKey(v)}>
          <SelectTrigger className="w-48">
            <span className="shrink-0 text-muted-foreground">Sort:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_SORT}>Default</SelectItem>
            {sortableCols.flatMap((c) => [
              <SelectItem key={`${c.key}:asc`} value={`${c.key}:asc`}>
                {labelOf(c)} ↑
              </SelectItem>,
              <SelectItem key={`${c.key}:desc`} value={`${c.key}:desc`}>
                {labelOf(c)} ↓
              </SelectItem>,
            ])}
          </SelectContent>
        </Select>
      )}
      {hideableCols.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <Columns3 data-icon="inline-start" />
            Columns
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {hideableCols.map((c) => (
              <DropdownMenuCheckboxItem
                key={c.key}
                checked={!hidden.has(c.key)}
                onCheckedChange={() => toggleColumn(c.key)}
              >
                {labelOf(c)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  if (rows.length === 0) {
    return <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />;
  }

  return (
    <>
      {toolbar}
      {processed.length === 0 ? (
        <EmptyState icon={empty.icon} title="No matches" description="Try a different search." />
      ) : (
        <>
          {/* Desktop / tablet: table */}
          <div className="hidden md:block">
            <Table containerClassName={stickyHeader ? "max-h-[75vh] overflow-auto" : undefined}>
              <TableHeader>
                <TableRow>
                  {visibleColumns.map((c) => (
                    <TableHead
                      key={c.key}
                      className={cn(
                        c.align === "right" && "text-right",
                        stickyHeader && "sticky top-0 z-10 bg-background",
                      )}
                    >
                      {c.header}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => (
                  <TableRow key={rowKey(row)}>
                    {visibleColumns.map((c) => (
                      <TableCell
                        key={c.key}
                        className={cn(
                          c.align === "right" && "text-right",
                          c.wrap && "whitespace-normal wrap-break-word",
                        )}
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
            {pageRows.map((row) => (
              <div key={rowKey(row)} className="rounded-lg border p-3">
                {visibleColumns.map((c) => {
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

          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between gap-3 text-sm">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPageState(page - 1)}
              >
                Prev
              </Button>
              <span className="text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPageState(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
