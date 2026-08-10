"use client";

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Columns3, Palette, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { assignRowColorSlots } from "@/lib/row-colors";
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
import { Checkbox } from "@/components/ui/checkbox";
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
 * Row selection, owned by the caller rather than the table.
 *
 * The set lives outside on purpose: this table filters, sorts and pages its
 * rows client-side, so a selection held internally would quietly reset — or
 * worse, silently keep rows the user can no longer see with no way to tell.
 * The page that acts on the selection is the page that should hold it.
 */
export type DataTableSelection = {
  selected: Set<string>;
  /** Called with every affected row key and the state they should all take. */
  onChange: (keys: string[], selected: boolean) => void;
  /** Header checkbox tooltip/aria, e.g. "Select all orders on this page". */
  label?: string;
};

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
  colorGroupBy,
  colorToggleLabel = "Multicolor",
  rowTone,
  selection,
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
  /**
   * Optional: group rows sharing this key under the same color (e.g. same
   * date -> same color), toggled on/off via a toolbar button. Assignment is
   * first-seen and stable regardless of sort/search/paging.
   */
  colorGroupBy?: (row: T) => string;
  colorToggleLabel?: string;
  /**
   * Classes for a whole row, when the row itself means something — a
   * cancellation in the call list, say. Applied after the colour-grouping
   * classes so it wins: grouping is a reading aid the user switches on, and
   * this is the data saying something about itself.
   */
  rowTone?: (row: T) => string | undefined;
  /** Adds a leading checkbox column. Omit for a table nothing acts on in bulk. */
  selection?: DataTableSelection;
}) {
  const [pageState, setPageState] = useState(1);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState(DEFAULT_SORT); // "<colKey>:asc|desc"
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(columns.filter((c) => c.hideable && c.defaultHidden).map((c) => c.key)),
  );
  const [colorOn, setColorOn] = useState(false);

  const sortableCols = columns.filter((c) => c.sortValue);
  const hideableCols = columns.filter((c) => c.hideable);
  const hasToolbar =
    !!searchText || sortableCols.length > 0 || hideableCols.length > 0 || !!colorGroupBy;

  const colorSlots = useMemo(
    () => (colorGroupBy ? assignRowColorSlots(rows, colorGroupBy) : null),
    [rows, colorGroupBy],
  );
  const colorClassFor = (row: T) =>
    colorOn && colorSlots && colorGroupBy ? colorSlots.get(colorGroupBy(row)) : undefined;

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

  // Header checkbox acts on what the user can actually see — the current page
  // after search and sort — never on rows hidden behind a filter or a page
  // they'd have no way of knowing they'd just selected.
  const pageKeys = pageRows.map(rowKey);
  const selectedOnPage = selection ? pageKeys.filter((k) => selection.selected.has(k)).length : 0;
  const allOnPageSelected = selectedOnPage > 0 && selectedOnPage === pageKeys.length;

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
        <Select
          value={sortKey}
          onValueChange={(v) => v && setSortKey(v)}
          // items is required for SelectValue to render labels instead of the
          // raw value (base-ui gotcha with non-enum values like "__default__").
          items={[
            { value: DEFAULT_SORT, label: "Default" },
            ...sortableCols.flatMap((c) => [
              { value: `${c.key}:asc`, label: `${labelOf(c)} ↑` },
              { value: `${c.key}:desc`, label: `${labelOf(c)} ↓` },
            ]),
          ]}
        >
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
      {colorGroupBy && (
        <Button
          type="button"
          variant={colorOn ? "secondary" : "outline"}
          size="sm"
          onClick={() => setColorOn((v) => !v)}
        >
          <Palette data-icon="inline-start" />
          {colorToggleLabel}
        </Button>
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
                  {selection && (
                    <TableHead
                      className={cn("w-10", stickyHeader && "sticky top-0 z-10 bg-background")}
                    >
                      <Checkbox
                        checked={allOnPageSelected}
                        indeterminate={selectedOnPage > 0 && !allOnPageSelected}
                        onCheckedChange={(on) => selection.onChange(pageKeys, on === true)}
                        aria-label={selection.label ?? "Select all rows"}
                      />
                    </TableHead>
                  )}
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
                  <TableRow
                    key={rowKey(row)}
                    data-selected={selection?.selected.has(rowKey(row)) || undefined}
                    className={cn(
                      "border-l-4 border-l-transparent",
                      colorClassFor(row),
                      rowTone?.(row),
                      // Wins over the colour-grouping tint so a selected row is
                      // still obviously selected on a multicolour list.
                      "data-selected:bg-primary/10",
                    )}
                  >
                    {selection && (
                      <TableCell>
                        <Checkbox
                          checked={selection.selected.has(rowKey(row))}
                          onCheckedChange={(on) => selection.onChange([rowKey(row)], on === true)}
                          aria-label="Select row"
                        />
                      </TableCell>
                    )}
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
              <div
                key={rowKey(row)}
                data-selected={selection?.selected.has(rowKey(row)) || undefined}
                className={cn(
                  "rounded-lg border border-l-4 border-l-transparent p-3",
                  colorClassFor(row),
                  rowTone?.(row),
                  "data-selected:bg-primary/10",
                )}
              >
                {selection && (
                  <div className="mb-2 flex items-center gap-2 border-b pb-2">
                    <Checkbox
                      checked={selection.selected.has(rowKey(row))}
                      onCheckedChange={(on) => selection.onChange([rowKey(row)], on === true)}
                      aria-label="Select row"
                    />
                    <span className="text-xs text-muted-foreground">Select</span>
                  </div>
                )}
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
                      {/* wrap-break-word: a long unbroken value (URL, error text)
                          must fold inside the card, not widen the page. */}
                      <span
                        className={cn(
                          "min-w-0 wrap-break-word",
                          c.align === "right" && "text-right",
                        )}
                      >
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
