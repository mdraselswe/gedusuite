"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * A declarative filter bar for list pages, in the same spirit as DataTable's
 * column spec: a page describes what its rows can be filtered by and gets the
 * controls, the "showing N of M" line and the clear button for free.
 *
 * Filters marked `primary` stay on screen — the one filter a page is really
 * about (call status, treasury direction) shouldn't cost a click. The rest sit
 * behind the toggle so a page isn't a wall of inputs.
 *
 * Two ways in, one look:
 *   useFilterBar   — pages holding every row in memory; filters here too
 *   UrlFilterBar   — pages querying the server per page (orders, purchases),
 *                    where the filter has to reach the database and so has to
 *                    live in the URL
 */

export const ANY_VALUE = "__any__";

export type SelectOption = { value: string; label: string };

type Base = {
  key: string;
  /**
   * Names the dimension, not one of its values — on a select this doubles as
   * the unset row at the top of the dropdown, so a label matching one of the
   * options lists that option twice.
   */
  label: string;
  /** Kept out of the collapsible panel and always on screen. */
  primary?: boolean;
};

/** The shape a control takes. `match` is only needed for in-memory filtering. */
export type FilterDef<T> = Base &
  (
    | {
        kind: "select";
        options: SelectOption[];
        /** Called only for a real selection — never for "any". */
        match?: (row: T, value: string) => boolean;
      }
    | { kind: "dateRange"; value?: (row: T) => string }
    | { kind: "numberRange"; value?: (row: T) => number; step?: string }
  );

export type FilterState = Record<string, string>;

export const fromKey = (k: string) => `${k}:from`;
export const toKey = (k: string) => `${k}:to`;

/** Blank means "no bound"; unparseable means the same, so a half-typed
 *  "-" or "." doesn't empty the table mid-keystroke. */
function bound(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function isSet<T>(def: FilterDef<T>, s: FilterState): number {
  if (def.kind === "select") return s[def.key] && s[def.key] !== ANY_VALUE ? 1 : 0;
  return (s[fromKey(def.key)] ? 1 : 0) + (s[toKey(def.key)] ? 1 : 0);
}

function keep<T>(row: T, def: FilterDef<T>, s: FilterState): boolean {
  if (def.kind === "select") {
    const v = s[def.key];
    if (!v || v === ANY_VALUE) return true;
    return def.match ? def.match(row, v) : true;
  }
  if (def.kind === "dateRange") {
    if (!def.value) return true;
    // ISO yyyy-mm-dd compares correctly as text, and keeps timezones out of
    // what is only ever a calendar question. Both ends are inclusive.
    const v = def.value(row);
    if (s[fromKey(def.key)] && v < s[fromKey(def.key)]) return false;
    if (s[toKey(def.key)] && v > s[toKey(def.key)]) return false;
    return true;
  }
  if (!def.value) return true;
  const v = def.value(row);
  const lo = bound(s[fromKey(def.key)]);
  const hi = bound(s[toKey(def.key)]);
  if (lo !== null && v < lo) return false;
  if (hi !== null && v > hi) return false;
  return true;
}

export function applyFilterDefs<T>(rows: T[], defs: FilterDef<T>[], s: FilterState): T[] {
  return rows.filter((row) => defs.every((d) => keep(row, d, s)));
}

export function countActive<T>(defs: FilterDef<T>[], s: FilterState): number {
  return defs.reduce((n, d) => n + isSet(d, s), 0);
}

/**
 * Returns the filtered rows and the bar to render above the table. A hook
 * rather than a wrapper component so the page keeps ownership of its layout,
 * and so filtered rows are a plain value instead of a callback that would
 * have to be pushed back up through state.
 */
export function useFilterBar<T>(
  rows: T[],
  defs: FilterDef<T>[],
  options?: {
    /** Totals for the filtered set — the reason to filter a money list. */
    summary?: (rows: T[]) => React.ReactNode;
    /**
     * How many rows exist in total, when that is more than were handed in —
     * a page that searches or paginates on the server holds one page of a
     * larger list, and "of 50" would describe the fetch rather than the list.
     */
    total?: number;
  },
): { rows: T[]; bar: React.ReactNode; active: number } {
  const [state, setState] = useState<FilterState>({});

  // Not memoised: `defs` is rebuilt on every render of the calling page, so a
  // memo would never hit. Filtering a few hundred in-memory rows is cheaper
  // than the render that follows it.
  const filtered = applyFilterDefs(rows, defs, state);
  const active = countActive(defs, state);

  const bar = (
    <FilterPanel
      defs={defs}
      state={state}
      onSet={(k, v) => setState((s) => ({ ...s, [k]: v }))}
      onClear={() => setState({})}
      active={active}
      count={{ shown: filtered.length, total: options?.total ?? rows.length }}
      summary={options?.summary?.(filtered)}
    />
  );

  return { rows: filtered, bar, active };
}

/**
 * The same bar over URL state, for pages whose filters have to reach the
 * database. The caller owns the URL because these pages also carry search,
 * sort and page params that this component knows nothing about.
 */
export function UrlFilterBar<T>({
  defs,
  state,
  onChange,
  count,
  summary,
}: {
  defs: FilterDef<T>[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** Server-side counts — "of" is the unfiltered total across all pages. */
  count?: { shown: number; total: number };
  summary?: React.ReactNode;
}) {
  return (
    <FilterPanel
      defs={defs}
      state={state}
      onSet={(k, v) => onChange({ ...state, [k]: v })}
      onClear={() => onChange({})}
      active={countActive(defs, state)}
      count={count}
      summary={summary}
    />
  );
}

function FilterPanel<T>({
  defs,
  state,
  onSet,
  onClear,
  active,
  count,
  summary,
}: {
  defs: FilterDef<T>[];
  state: FilterState;
  onSet: (key: string, value: string) => void;
  onClear: () => void;
  active: number;
  count?: { shown: number; total: number };
  summary?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const primary = defs.filter((d) => d.primary);
  const advanced = defs.filter((d) => !d.primary);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {primary.map((d) => (
          <Control key={d.key} def={d} state={state} onSet={onSet} compact />
        ))}
        {advanced.length > 0 && (
          <Button
            type="button"
            variant={active > countActive(primary, state) ? "default" : "outline"}
            size="sm"
            onClick={() => setOpen((o) => !o)}
          >
            <SlidersHorizontal data-icon="inline-start" />
            Filters{active > 0 && ` (${active})`}
          </Button>
        )}
      </div>

      {open && advanced.length > 0 && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {advanced.map((d) => (
              <div key={d.key} className="space-y-1.5">
                <Label className="text-xs">{d.label}</Label>
                <Control def={d} state={state} onSet={onSet} />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {count && (
              <span className="text-muted-foreground">
                Showing <span className="font-semibold text-foreground">{count.shown}</span> of{" "}
                {count.total}
              </span>
            )}
            {summary}
            {active > 0 && (
              <button
                type="button"
                className="ml-auto text-xs text-muted-foreground underline"
                onClick={onClear}
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Control<T>({
  def,
  state,
  onSet,
  compact,
}: {
  def: FilterDef<T>;
  state: FilterState;
  onSet: (key: string, value: string) => void;
  compact?: boolean;
}) {
  if (def.kind === "select") {
    const options = [{ value: ANY_VALUE, label: def.label }, ...def.options];
    return (
      <Select
        value={state[def.key] || ANY_VALUE}
        onValueChange={(v) => onSet(def.key, v ?? ANY_VALUE)}
        items={options}
      >
        <SelectTrigger className={compact ? "h-9 w-44" : "w-full"}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const isDate = def.kind === "dateRange";
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type={isDate ? "date" : "number"}
        step={isDate ? undefined : (def.step ?? "0.01")}
        placeholder={isDate ? undefined : "Min"}
        aria-label={`${def.label} from`}
        value={state[fromKey(def.key)] ?? ""}
        onChange={(e) => onSet(fromKey(def.key), e.target.value)}
      />
      <span className="text-muted-foreground">–</span>
      <Input
        type={isDate ? "date" : "number"}
        step={isDate ? undefined : (def.step ?? "0.01")}
        placeholder={isDate ? undefined : "Max"}
        aria-label={`${def.label} to`}
        value={state[toKey(def.key)] ?? ""}
        onChange={(e) => onSet(toKey(def.key), e.target.value)}
      />
    </div>
  );
}
