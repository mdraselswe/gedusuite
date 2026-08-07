"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Coins, Wallet, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Badge } from "@/components/ui/badge";
import { Field } from "@/components/ui/field";
import { FigureList, FigureRow } from "@/components/ui/figure-list";
import { InfoNote } from "@/components/ui/info-note";
import { Money } from "@/components/ui/money";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import {
  spendCategoryLabel,
  spendFundingLabel,
  summarizeRows,
  type SpendCategory,
  type SpendRow,
  type SpendingSummary,
} from "@/lib/spending";
import { cn } from "@/lib/utils";

/** One day either side of the current start date. */
function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

function prettyDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Credit is the one funding state that hasn't cost anything yet. */
const fundingTone = {
  TREASURY: "text-foreground",
  PARTNER: "text-foreground",
  CREDIT: "text-amber-700 dark:text-amber-400",
  UNRECORDED: "text-muted-foreground",
} as const;

export function ExpensesView({
  slug,
  from,
  to,
  today,
  weekAgo,
  monthStart,
  summary,
}: {
  slug: string;
  from: string;
  to: string;
  today: string;
  weekAgo: string;
  monthStart: string;
  summary: SpendingSummary;
}) {
  const router = useRouter();
  const singleDay = from === to;

  // Which categories are being left out. Excluding rather than including is
  // the right default direction: the question is nearly always "what did the
  // day cost if you don't count the restock", and starting from everything
  // means a fresh page shows the whole truth rather than an empty filter.
  const [excluded, setExcluded] = useState<Set<SpendCategory>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = useMemo(
    () => summary.rows.filter((r) => !excluded.has(r.category)),
    [summary.rows, excluded],
  );
  // Every figure on the page is recomputed from the rows on screen, not
  // adjusted from the server's totals — subtracting one set of rounded numbers
  // from another is how a breakdown stops adding up to its own total.
  const shown = useMemo(() => summarizeRows(visible), [visible]);

  // A selection only means the rows still visible: excluding a category with
  // ticked rows inside it must not leave them counted from somewhere off-screen.
  const selectedRows = useMemo(
    () => visible.filter((r) => selected.has(r.id)),
    [visible, selected],
  );
  const picked = useMemo(() => summarizeRows(selectedRows), [selectedRows]);

  const allVisibleSelected = visible.length > 0 && selectedRows.length === visible.length;
  const someSelected = selectedRows.length > 0;

  function toggleCategory(c: SpendCategory) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function go(nextFrom: string, nextTo: string) {
    router.push(`/${slug}/expenses?from=${nextFrom}&to=${nextTo}`);
  }

  const presets: { label: string; from: string; to: string }[] = [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: shiftDay(today, -1), to: shiftDay(today, -1) },
    { label: "Last 7 days", from: weekAgo, to: today },
    { label: "This month", from: monthStart, to: today },
  ];

  const columns: Column<SpendRow>[] = [
    {
      key: "pick",
      header: (
        <Checkbox
          aria-label={allVisibleSelected ? "Clear selection" : "Select all rows"}
          checked={allVisibleSelected}
          // Half-picked reads as neither on nor off, which is exactly what it is.
          indeterminate={someSelected && !allVisibleSelected}
          onCheckedChange={() =>
            setSelected(
              allVisibleSelected ? new Set() : new Set(visible.map((r) => r.id)),
            )
          }
        />
      ),
      label: "Select",
      cardFullWidth: true,
      cell: (r) => (
        <Checkbox
          aria-label={`Select ${r.label}`}
          checked={selected.has(r.id)}
          onCheckedChange={() => toggleRow(r.id)}
        />
      ),
    },
    ...(singleDay
      ? []
      : [{ key: "date", header: "Date", cell: (r: SpendRow) => r.date } as Column<SpendRow>]),
    {
      key: "category",
      header: "Category",
      cell: (r) => (
        <Badge variant="secondary" className="whitespace-nowrap">
          {spendCategoryLabel[r.category]}
        </Badge>
      ),
    },
    {
      key: "what",
      header: "What",
      cardTitle: true,
      cell: (r) => (
        <div className="min-w-0">
          <Link href={r.href} className="font-medium hover:underline">
            {r.label}
          </Link>
          {r.detail && <div className="text-xs text-muted-foreground">{r.detail}</div>}
        </div>
      ),
    },
    {
      key: "funding",
      header: "Whose money",
      cell: (r) => (
        <span className={cn("text-sm whitespace-nowrap", fundingTone[r.funding])}>
          {r.paidBy ?? spendFundingLabel[r.funding]}
        </span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortValue: (r) => r.amount,
      cell: (r) => <Money value={r.amount} className="font-medium" />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Date controls. A single day is the default and the arrows step it, so
          "what went out yesterday" is one click rather than two date pickers. */}
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {singleDay && (
              <div className="flex items-center gap-1 self-end pb-0.5">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous day"
                  onClick={() => go(shiftDay(from, -1), shiftDay(from, -1))}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next day"
                  disabled={from >= today}
                  onClick={() => go(shiftDay(from, 1), shiftDay(from, 1))}
                >
                  <ChevronRight />
                </Button>
              </div>
            )}
            <Field name="from" label={singleDay ? "Day" : "From"} className="w-40">
              <Input
                type="date"
                value={from}
                max={today}
                onChange={(e) =>
                  e.target.value && go(e.target.value, singleDay ? e.target.value : to)
                }
              />
            </Field>
            {!singleDay && (
              <Field name="to" label="To" className="w-40">
                <Input
                  type="date"
                  value={to}
                  max={today}
                  onChange={(e) => e.target.value && go(from, e.target.value)}
                />
              </Field>
            )}
            <div className="flex flex-wrap gap-1.5 pb-0.5">
              {presets.map((p) => (
                <Button
                  key={p.label}
                  size="sm"
                  variant={from === p.from && to === p.to ? "secondary" : "ghost"}
                  onClick={() => go(p.from, p.to)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {singleDay ? prettyDay(from) : `${prettyDay(from)} — ${prettyDay(to)}`}
          </p>
        </CardContent>
      </Card>

      {/* Category toggles. Every category present in the range gets a chip;
          switching one off takes it out of every figure below, so "what did
          the day cost apart from the restock" is one click. */}
      {summary.byCategory.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Include:</span>
          {summary.byCategory.map((c) => {
            const off = excluded.has(c.category);
            return (
              <Button
                key={c.category}
                size="sm"
                variant={off ? "ghost" : "secondary"}
                onClick={() => toggleCategory(c.category)}
                className={cn(off && "text-muted-foreground line-through")}
                aria-pressed={!off}
              >
                {spendCategoryLabel[c.category]}
                <span className="ml-1 tabular-nums opacity-70">
                  <Money value={c.amount} bare />
                </span>
              </Button>
            );
          })}
          {excluded.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setExcluded(new Set())}>
              <X /> Show all
            </Button>
          )}
        </div>
      )}

      <StatGrid className="lg:grid-cols-3">
        <StatTile
          label={excluded.size > 0 ? "Spent (filtered)" : "Money spent"}
          value={shown.total}
          icon={<Coins />}
          color="orange"
          sub={
            visible.length === 0
              ? "nothing to show"
              : excluded.size > 0
                ? `${visible.length} of ${summary.rows.length} entries shown`
                : `${shown.byCategory.length} categor${shown.byCategory.length === 1 ? "y" : "ies"} · ${visible.length} entries`
          }
          footer={
            excluded.size > 0 ? (
              <p className="text-xs text-muted-foreground">
                Everything together: <Money value={summary.total} />
              </p>
            ) : undefined
          }
        />
        <StatTile
          label="Out of the treasury"
          value={shown.byFunding.find((f) => f.funding === "TREASURY")?.amount ?? 0}
          icon={<Wallet />}
          color="amber"
          sub="the rest came from partners, credit, or wasn't recorded"
        />
        {summary.payoutTotal > 0 && (
          <StatTile
            label="Paid out to partners"
            value={summary.payoutTotal}
            icon={<Wallet />}
            color="cyan"
            sub="not counted as spending — see below"
          />
        )}
      </StatGrid>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {summary.rows.length === 0
              ? `Nothing was spent ${singleDay ? "on this day" : "in this range"}.`
              : "Every category is switched off — turn one back on to see the entries."}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Where it went</CardTitle>
              </CardHeader>
              <CardContent>
                <FigureList>
                  {shown.byCategory.map((c) => (
                    <FigureRow
                      key={c.category}
                      label={spendCategoryLabel[c.category]}
                      hint={`${c.count} entr${c.count === 1 ? "y" : "ies"}`}
                      value={c.amount}
                    />
                  ))}
                  <FigureRow
                    label={excluded.size > 0 ? "Total shown" : "Total spent"}
                    value={shown.total}
                    total
                  />
                  {excluded.size > 0 && (
                    <FigureRow
                      label="Left out by the filter"
                      value={summary.total - shown.total}
                      tone="muted"
                      sub
                    />
                  )}
                </FigureList>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Whose money</CardTitle>
                </CardHeader>
                <CardContent>
                  <FigureList>
                    {shown.byFunding.map((f) => (
                      <FigureRow
                        key={f.funding}
                        label={spendFundingLabel[f.funding]}
                        value={f.amount}
                        tone={f.funding === "UNRECORDED" ? "muted" : "neutral"}
                      />
                    ))}
                  </FigureList>
                </CardContent>
              </Card>

              {/* The distinction that makes this page readable next to the
                  reports, which will disagree with it on purpose. */}
              <InfoNote title="This is money out, not profit lost">
                <p>
                  Stock bought to resell is spending on the day it&apos;s paid for, but
                  it doesn&apos;t touch profit until it sells — so a{" "}
                  <Money value={30000} /> restock shows here in full and as nothing at
                  all on the reports page for the same day.
                </p>
                <p>
                  A cost set to spread over months is the other way round: the cash
                  left once, on the day it appears here, while the reports charge a
                  slice of it to each month it covers.
                </p>
                <p>
                  Anything marked{" "}
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    on credit
                  </span>{" "}
                  is counted here as spending on the day the goods arrived, but no
                  money has left yet — it&apos;s owed to the supplier.
                </p>
              </InfoNote>
            </div>
          </div>

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">Every entry</CardTitle>
              {someSelected && (
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  <X /> Clear {selectedRows.length} selected
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Adding up a few rows by hand is what a phone calculator was
                  for. Tick them and the same breakdown appears for just those. */}
              {someSelected && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">
                      {selectedRows.length} of {visible.length} selected
                    </span>
                    <span className="text-xl font-semibold">
                      <Money value={picked.total} />
                    </span>
                  </div>
                  <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    <FigureList className="text-xs">
                      {picked.byCategory.map((c) => (
                        <FigureRow
                          key={c.category}
                          label={`${spendCategoryLabel[c.category]} (${c.count})`}
                          value={c.amount}
                        />
                      ))}
                    </FigureList>
                    <FigureList className="text-xs">
                      {picked.byFunding.map((f) => (
                        <FigureRow
                          key={f.funding}
                          label={spendFundingLabel[f.funding]}
                          value={f.amount}
                          tone={f.funding === "UNRECORDED" ? "muted" : "neutral"}
                        />
                      ))}
                    </FigureList>
                  </div>
                  {picked.total !== shown.total && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      The other {visible.length - selectedRows.length} entr
                      {visible.length - selectedRows.length === 1 ? "y" : "ies"} come to{" "}
                      <Money value={shown.total - picked.total} />.
                    </p>
                  )}
                </div>
              )}
              <DataTable
                rows={visible}
                rowKey={(r) => r.id}
                columns={columns}
                empty={{ title: "Nothing spent" }}
              />
            </CardContent>
          </Card>
        </>
      )}

      {summary.payouts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Paid out to partners — <Money value={summary.payoutTotal} />
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Money that left, and deliberately not in the totals above: a partner
              taking their profit or their capital back is not a cost the business
              bore.
            </p>
          </CardHeader>
          <CardContent>
            <FigureList>
              {summary.payouts.map((p) => (
                <FigureRow
                  key={p.id}
                  label={p.paidBy ? `${p.label} — ${p.paidBy}` : p.label}
                  hint={p.date}
                  value={p.amount}
                  tone="muted"
                />
              ))}
            </FigureList>
          </CardContent>
        </Card>
      )}

      <Link
        href={`/${slug}/reports?from=${from}&to=${to}`}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        See the profit side of this range
      </Link>
    </div>
  );
}
