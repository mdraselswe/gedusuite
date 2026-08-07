"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Coins, Wallet } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
          {r.detail && (
            <div className="text-xs text-muted-foreground">{r.detail}</div>
          )}
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
                onChange={(e) => e.target.value && go(e.target.value, singleDay ? e.target.value : to)}
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

      <StatGrid className="lg:grid-cols-3">
        <StatTile
          label="Money spent"
          value={summary.total}
          icon={<Coins />}
          color="orange"
          sub={
            summary.rows.length === 0
              ? "nothing recorded"
              : `${summary.byCategory.length} categor${summary.byCategory.length === 1 ? "y" : "ies"} · ${summary.rows.length} entries`
          }
        />
        <StatTile
          label="Out of the treasury"
          value={summary.byFunding.find((f) => f.funding === "TREASURY")?.amount ?? 0}
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

      {summary.rows.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nothing was spent {singleDay ? "on this day" : "in this range"}.
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
                  {summary.byCategory.map((c) => (
                    <FigureRow
                      key={c.category}
                      label={spendCategoryLabel[c.category]}
                      hint={`${c.count} entr${c.count === 1 ? "y" : "ies"}`}
                      value={c.amount}
                    />
                  ))}
                  <FigureRow label="Total spent" value={summary.total} total />
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
                    {summary.byFunding.map((f) => (
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
            <CardHeader>
              <CardTitle className="text-base">Every entry</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable
                rows={summary.rows}
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
