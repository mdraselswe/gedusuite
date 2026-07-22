"use client";

import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { ChevronDownIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComboOption = { value: string; label: string };

type Page<T> = { items: T[]; next: number | null };

/**
 * Server-backed autocomplete: the option list is fetched from the server as
 * the user types (debounced) and paged in on scroll, so a dropdown never has
 * to load every product/customer up front. Client-side filtering is disabled
 * (`filter={null}`) because the server does the searching.
 *
 * The selected value is held as the full option object (not just an id), so
 * its label keeps showing even after the fetched list has scrolled past it.
 */
export function AsyncCombobox<T extends ComboOption>({
  value,
  onChange,
  fetchPage,
  placeholder,
  disabled,
  emptyText = "No matches",
  renderItem,
  id,
  className,
}: {
  value: T | null;
  onChange: (option: T | null) => void;
  fetchPage: (query: string, cursor: number) => Promise<Page<T>>;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  renderItem?: (option: T) => React.ReactNode;
  id?: string;
  className?: string;
}) {
  const [items, setItems] = React.useState<T[]>([]);
  const [query, setQuery] = React.useState("");
  const [next, setNext] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  // Guards against out-of-order responses: only the newest reset-fetch's
  // results are applied, so a slow early query can't clobber a later one.
  const reqId = React.useRef(0);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const runFetch = React.useCallback(
    async (q: string, cursor: number, reset: boolean) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const page = await fetchPage(q, cursor);
        if (id !== reqId.current) return; // superseded
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
        setNext(page.next);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [fetchPage],
  );

  // Debounced search whenever the query changes while open.
  React.useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runFetch(query, 0, true), 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, runFetch]);

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen && items.length === 0) runFetch("", 0, true);
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el || loading || next == null) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
      runFetch(query, next, false);
    }
  }

  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={(v) => onChange((v as T) ?? null)}
      onInputValueChange={(v) => setQuery(v)}
      onOpenChange={onOpenChange}
      filter={null}
      itemToStringLabel={(o) => (o as T | null)?.label ?? ""}
      isItemEqualToValue={(a, b) => (a as T)?.value === (b as T)?.value}
    >
      <div className={cn("relative", className)}>
        <Combobox.Input
          id={id}
          placeholder={placeholder}
          disabled={disabled}
          className="flex h-10 w-full items-center rounded-lg border border-input bg-transparent py-2 pr-8 pl-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        />
        <Combobox.Icon className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground">
          <ChevronDownIcon className="size-4" />
        </Combobox.Icon>
      </div>

      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} className="isolate z-50" align="start">
          <Combobox.Popup
            ref={scrollRef}
            onScroll={onScroll}
            // max-w-md caps the popup on wide anchors — a full-width form field
            // would otherwise make the dropdown span the whole page.
            className="max-h-64 w-(--anchor-width) max-w-md min-w-48 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none"
          >
            <Combobox.List>
              {(option: T) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className="flex cursor-default items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  {renderItem ? renderItem(option) : option.label}
                </Combobox.Item>
              )}
            </Combobox.List>

            {loading && (
              <div className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="py-3 text-center text-sm text-muted-foreground">{emptyText}</div>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
