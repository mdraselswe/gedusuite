"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layers } from "lucide-react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  updateCampaign,
  createAdSet,
  updateAdSet,
  deleteAdSet,
  deleteDailySpend,
} from "@/server/actions/boosting";
import { submitOrQueue } from "@/lib/offline-queue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { BoostStatusBadge } from "@/components/boosting/boost-status-badge";
import { ORDER_SOURCES, ORDER_SOURCE_LABEL, orderSourceLabel } from "@/lib/order-source";
import { cn } from "@/lib/utils";
import { roasVerdict, type CampaignResult } from "@/lib/boost-results";
import { formatMoney as money } from "@/lib/money";
import { Money } from "@/components/ui/money";
import { Field } from "@/components/ui/field";
import { Stamp } from "@/components/ui/stamp";
import { toDhakaInputValue, type DhakaStamp } from "@/lib/dhaka-time";

type Spend = DhakaStamp & {
  id: string;
  amount: number;
  note: string | null;
  paidFrom: string | null; // "Treasury" | partner display name | null (untracked)
};
type PartnerOption = { id: string; label: string };
type AdSet = {
  id: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string | null;
  dailyBudget: number | null;
  notes: string | null;
  totalSpent: number;
  spends: Spend[];
};
type Campaign = {
  id: string;
  name: string;
  objective: string | null;
  channel: string | null;
  status: string;
  notes: string | null;
  totalSpent: number;
};

const STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
const NONE = "__none__";
const TREASURY = "__treasury__";
/** "Any channel" in the campaign form — the estimate then doesn't narrow. */
const ANY_CHANNEL = "__any__";

/** Today's date in the user's local timezone as YYYY-MM-DD (toISOString would
 * shift to the previous day for +06:00 mornings). */
function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA");
}

function StatusSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "ACTIVE")}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChannelSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const label = value === ANY_CHANNEL ? "Any channel" : orderSourceLabel(value);
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v ?? ANY_CHANNEL)}
      items={[
        { value: ANY_CHANNEL, label: "Any channel" },
        ...ORDER_SOURCES.map((s) => ({ value: s, label: ORDER_SOURCE_LABEL[s] })),
      ]}
    >
      <SelectTrigger className="w-full">
        <span data-slot="select-value">{label}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY_CHANNEL}>Any channel</SelectItem>
        {ORDER_SOURCES.map((s) => (
          <SelectItem key={s} value={s}>
            {ORDER_SOURCE_LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * What the campaign earned against what it cost.
 *
 * The basis is stated in the open — a number computed from tagged orders and
 * one guessed from a date window are not the same claim, and a ROAS that
 * doesn't say which it is invites a decision it can't support.
 */
function ResultsCard({
  slug,
  result,
  overlaps,
  window,
  channel,
}: {
  slug: string;
  result: CampaignResult;
  overlaps: string[];
  window: { from: string; to: string | null } | null;
  channel: string | null;
}) {
  const estimated = result.basis === "ESTIMATED";
  const verdict = roasVerdict(result);

  // Everything except the headline. ROAS carries its own break-even line, so
  // it isn't judged against 1.0× by a reader who doesn't know the margin.
  const stats: {
    label: string;
    value: string;
    hint?: string;
    note?: string;
    tone?: "good" | "bad";
  }[] = [
    {
      label: "Margin",
      value: result.margin === null ? "—" : `${(result.margin * 100).toFixed(1)}%`,
      hint: "Profit ÷ revenue on these orders",
    },
    {
      label: "ROAS",
      value: result.roas === null ? "—" : `${result.roas.toFixed(2)}×`,
      hint: "Revenue per taka of ad spend",
      note:
        result.roas === null
          ? undefined
          : result.breakEvenRoas === null
            ? "these orders make no profit"
            : `break-even ${result.breakEvenRoas.toFixed(2)}×`,
      tone: verdict ?? undefined,
    },
    {
      label: "Cost per order",
      value: result.cpa === null ? "—" : money(result.cpa),
      hint: "Ad spend ÷ orders",
    },
    {
      label: "Profit before ads",
      value: money(result.profit),
      hint: "What the orders themselves made",
    },
    {
      label: "Cancelled",
      value:
        result.cancelledOrders === 0
          ? "—"
          : `${result.cancelledOrders} · ${((result.cancelRate ?? 0) * 100).toFixed(0)}%`,
      hint: "Attributed orders that came back, and their share of everything this campaign produced",
      note:
        result.cancelledOrders === 0
          ? undefined
          : `${money(result.cancelledCost)} lost, already in the profit`,
      // The ads were paid for whether or not the order stuck, so a campaign
      // that produces returns is worse than its revenue makes it look.
      tone: (result.cancelRate ?? 0) >= 0.2 ? "bad" : undefined,
    },
  ];

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Results</CardTitle>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              result.basis === "TAGGED"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : estimated
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {result.basis === "TAGGED"
              ? `Exact — ${result.taggedOrders} tagged order(s)`
              : estimated
                ? "Estimated"
                : "No orders yet"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {result.basis === "TAGGED" ? (
            <>
              From orders tagged to this campaign.
              {result.estimatedOrders > 0 &&
                ` ${result.estimatedOrders} more order(s) in the window are untagged and not counted — tag them on the sales page.`}
            </>
          ) : estimated ? (
            <>
              Nobody tagged an order to this campaign, so these are orders
              placed inside its dates
              {channel ? ` on ${orderSourceLabel(channel)}` : " on any channel"}
              {window ? ` (${window.from} → ${window.to ?? "running"})` : ""}. Tag
              orders on the sales page to make this exact.
            </>
          ) : (
            "No orders tagged to this campaign, and none placed inside its dates."
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The one number the decision comes from, sized like it. Every other
            figure here is working towards this one, so they sit below it at
            label size rather than competing with it. */}
        <div>
          <div className="text-xs text-muted-foreground">
            Profit after ads
            <span className="ml-1 font-normal">— what's left once the boost is paid for</span>
          </div>
          <div
            className={cn(
              "text-3xl font-bold tabular-nums",
              result.profitAfterAds >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-destructive",
            )}
          >
            {money(result.profitAfterAds)}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {result.orders} order(s) · {money(result.revenue)} revenue ·{" "}
            {money(result.spend)} ad spend
          </div>
        </div>

        <div className="grid gap-x-6 gap-y-3 border-t pt-3 sm:grid-cols-5">
          {stats.map((s) => (
            <div key={s.label}>
              <div className="text-xs text-muted-foreground" title={s.hint}>
                {s.label}
              </div>
              <div
                className={cn(
                  "text-lg font-bold tabular-nums",
                  s.tone === "good" && "text-emerald-600 dark:text-emerald-400",
                  s.tone === "bad" && "text-destructive",
                )}
              >
                {s.value}
              </div>
              {s.note && (
                <div className="text-xs text-muted-foreground tabular-nums">{s.note}</div>
              )}
            </div>
          ))}
        </div>

        {estimated && !channel && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            This campaign has no channel set, so every order in its dates is
            counted — including walk-ins and referrals. Set the channel on Edit
            for a sharper estimate.
          </p>
        )}
        {estimated && overlaps.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {overlaps.join(", ")} ran at the same time on the same channel — the
            same orders are counted for {overlaps.length > 1 ? "those" : "that"}{" "}
            campaign too. Tagging orders is the only way to split them.
          </p>
        )}

        {result.byChannel.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Which channel</div>
            <DataTable
              rows={result.byChannel}
              rowKey={(c) => c.source ?? "__unset__"}
              empty={{ title: "No orders attributed yet" }}
              columns={
                [
                  {
                    key: "source",
                    header: "Channel",
                    cardTitle: true,
                    cell: (c) => (
                      <span className={cn(!c.source && "text-amber-700 dark:text-amber-400")}>
                        {orderSourceLabel(c.source)}
                      </span>
                    ),
                  },
                  { key: "orders", header: "Orders", align: "right", cell: (c) => c.orders },
                  {
                    key: "cancelled",
                    header: "Cancelled",
                    align: "right",
                    // Which channel's orders come back is the question this
                    // table can answer and the headline tile can't: two
                    // channels with the same revenue are not the same channel
                    // if one of them keeps sending parcels home.
                    cell: (c) =>
                      c.cancelledOrders === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className="text-orange-700 dark:text-orange-400"
                          title={`${money(c.cancelledCost)} lost, already taken off this row's profit`}
                        >
                          {c.cancelledOrders}
                        </span>
                      ),
                  },
                  {
                    key: "revenue",
                    header: "Revenue",
                    align: "right",
                    cell: (c) => <span className="font-medium"><Money value={c.revenue} /></span>,
                  },
                  {
                    key: "profit",
                    header: "Profit",
                    align: "right",
                    cell: (c) => <Money value={c.profit} />,
                  },
                ] as Column<CampaignResult["byChannel"][number]>[]
              }
            />
          </div>
        )}

        {result.attributedOrders.length > 0 && (
          <div>
            <div className="mb-1 text-xs text-muted-foreground">
              The orders behind these numbers
              {estimated && " — matched by date and channel, not tagged"}
            </div>
            <DataTable
              rows={result.attributedOrders}
              rowKey={(o) => o.id}
              colorGroupBy={(o) => o.date}
              colorToggleLabel="Color by date"
              empty={{ title: "No orders attributed yet" }}
              columns={
                [
                  {
                    key: "date",
                    header: "Date",
                    cell: (o) => <Stamp date={o.date} time={o.time} entered={o.entered} />,
                  },
                  {
                    key: "customer",
                    header: "Customer",
                    cardTitle: true,
                    cell: (o) => (
                      <span className="inline-flex items-center gap-2">
                        {o.customerName}
                        {o.cancelled && (
                          <span
                            className="rounded bg-orange-500/10 px-1.5 py-0.5 text-xs text-orange-700 dark:text-orange-300"
                            title="Cancelled — the ad was paid for anyway, so its cost stays against this campaign"
                          >
                            cancelled
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: "source",
                    header: "Channel",
                    cell: (o) => (
                      <span className={cn(!o.source && "text-amber-700 dark:text-amber-400")}>
                        {orderSourceLabel(o.source)}
                      </span>
                    ),
                  },
                  {
                    key: "revenue",
                    header: "Revenue",
                    align: "right",
                    cell: (o) =>
                      o.cancelled ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Money value={o.revenue} />
                      ),
                  },
                  {
                    key: "profit",
                    header: "Profit",
                    align: "right",
                    cell: (o) => (
                      <span className={cn(o.cancelled && "text-orange-700 dark:text-orange-400")}>
                        <Money value={o.profit} />
                      </span>
                    ),
                  },
                  {
                    key: "links",
                    header: "",
                    cardFullWidth: true,
                    cell: (o) => (
                      <Link
                        href={`/${slug}/sales/orders/${o.id}/breakdown`}
                        className="text-sm underline underline-offset-4"
                      >
                        Breakdown
                      </Link>
                    ),
                  },
                ] as Column<CampaignResult["attributedOrders"][number]>[]
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AdSetFormFields({ adSet }: { adSet?: AdSet }) {
  return (
    <>
      <Field name="name" label="Ad set name" required>
        <Input
          id="as-name"
          name="name"
          required
          defaultValue={adSet?.name}
          placeholder="e.g. Dhaka 25-40 women"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field name="startDate" label="Start date" required>
          <Input
            id="as-start"
            name="startDate"
            type="date"
            required
            defaultValue={adSet?.startDate ?? todayLocal()}
          />
        </Field>
        <Field name="endDate" label="End date (optional)">
          <Input id="as-end" name="endDate" type="date" defaultValue={adSet?.endDate ?? ""} />
        </Field>
      </div>
      <Field name="dailyBudget" label="Daily budget (optional)">
        <Input
          id="as-budget"
          name="dailyBudget"
          type="number"
          step="0.01"
          min="0"
          defaultValue={adSet?.dailyBudget ?? ""}
          placeholder="Facebook-e set kora per-day budget"
        />
      </Field>
      <Field name="notes" label="Notes (optional)">
        <Input id="as-notes" name="notes" defaultValue={adSet?.notes ?? ""} />
      </Field>
    </>
  );
}

function AdSetCard({
  slug,
  adSet,
  partnerOptions,
  canAdd,
  canEdit,
  canDelete,
  onEdit,
}: {
  slug: string;
  adSet: AdSet;
  partnerOptions: PartnerOption[];
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  // Now, in Dhaka. Controlled so the value keeps up with the clock and a
  // form.reset() after each spend doesn't put back the time the page loaded.
  const [spendDate, setSpendDate] = useState(() => toDhakaInputValue(new Date()));
  // Sticky across entries — daily spends for an ad set almost always come off
  // the same card, so keep the last choice selected after submit.
  const [paidFrom, setPaidFrom] = useState<string>(NONE);

  // Facebook can charge several times in one day, so budget comparison is
  // against the DAY'S TOTAL, not each entry. A day is over budget when its
  // summed charges exceed the ad set's daily budget (small overshoot is
  // normal — FB can spend up to ~125% of daily — but worth surfacing).
  const dayTotals = new Map<string, number>();
  for (const s of adSet.spends) {
    dayTotals.set(s.date, (dayTotals.get(s.date) ?? 0) + s.amount);
  }
  const overBudgetDay = (date: string) =>
    adSet.dailyBudget !== null && (dayTotals.get(date) ?? 0) > adSet.dailyBudget;
  const overBudgetDays =
    adSet.dailyBudget !== null
      ? [...dayTotals.values()].filter((total) => total > adSet.dailyBudget!).length
      : 0;

  async function onAddSpend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdding(true);
    const fd = new FormData(e.currentTarget);
    const res = await submitOrQueue("boostSpend.create", slug, {
      adSetId: adSet.id,
      fundingSource: paidFrom === NONE ? "NONE" : paidFrom === TREASURY ? "TREASURY" : "PARTNER",
      paidByPartnerId: paidFrom === NONE || paidFrom === TREASURY ? "" : paidFrom,
      ...(Object.fromEntries(fd.entries()) as Record<string, unknown>),
    });
    setAdding(false);
    if (!res.ok) return toast.error(res.error ?? "Failed");
    toast.success(
      "queued" in res && res.queued ? "Saved offline — will sync when online" : "Spend added",
    );
    (e.target as HTMLFormElement).reset();
    setSpendDate(toDhakaInputValue(new Date()));
    router.refresh();
  }

  async function onDeleteSpend(s: Spend) {
    const ok = await confirmDialog({
      title: `Delete spend for ${s.date}?`,
      description:
        "This daily spend entry will be permanently removed, along with its linked treasury deduction or partner investment credit (if any).",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteDailySpend(slug, s.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Spend deleted");
    router.refresh();
  }

  async function onDeleteAdSet() {
    const ok = await confirmDialog({
      title: `Delete ad set "${adSet.name}"?`,
      description:
        "All its daily spend entries will be removed, along with any linked treasury deductions and partner investment credits.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteAdSet(slug, adSet.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Ad set deleted");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{adSet.name}</CardTitle>
          <div className="flex items-center gap-2">
            <BoostStatusBadge status={adSet.status} />
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={onEdit}>
                Edit
              </Button>
            )}
            {canDelete && (
              <Button variant="ghost" size="sm" onClick={onDeleteAdSet}>
                Delete
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>
            {adSet.startDate} → {adSet.endDate ?? "running"}
          </span>
          {adSet.dailyBudget !== null && <span>Daily budget: <Money value={adSet.dailyBudget} /></span>}
          <span>
            Spent: <span className="font-medium text-foreground"><Money value={adSet.totalSpent} /></span>
          </span>
          {overBudgetDays > 0 && (
            <span className="font-medium text-destructive">
              {overBudgetDays} day(s) over daily budget
            </span>
          )}
          {adSet.notes && <span>{adSet.notes}</span>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {canAdd && (
          <form
            onSubmit={onAddSpend}
            className="grid gap-3 rounded-md border bg-muted/40 p-3 sm:grid-cols-[10rem_minmax(0,8rem)_minmax(0,11rem)_minmax(0,1fr)_auto] sm:items-start"
          >
            <div className="space-y-2">
              <Label htmlFor={`sp-date-${adSet.id}`}>Date</Label>
              <Input
                id={`sp-date-${adSet.id}`}
                name="date"
                type="datetime-local"
                required
                value={spendDate}
                onChange={(e) => setSpendDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`sp-amount-${adSet.id}`}>Amount</Label>
              <Input
                id={`sp-amount-${adSet.id}`}
                name="amount"
                type="number"
                step="0.01"
                min="0"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Paid from</Label>
              <Select
                value={paidFrom}
                onValueChange={(v) => setPaidFrom(v ?? NONE)}
                items={[
                  { value: NONE, label: "— not tracked" },
                  { value: TREASURY, label: "Treasury" },
                  ...partnerOptions.map((p) => ({ value: p.id, label: p.label })),
                ]}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>— not tracked</SelectItem>
                  <SelectItem value={TREASURY}>Treasury</SelectItem>
                  {partnerOptions.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`sp-note-${adSet.id}`}>Note (optional)</Label>
              <Input id={`sp-note-${adSet.id}`} name="note" />
            </div>
            {/* Same label+control stack as the fields so the button row-aligns
                with the inputs instead of floating against the label line. */}
            <div className="space-y-2">
              <Label aria-hidden className="invisible select-none">
                Add
              </Label>
              <Button type="submit" disabled={adding}>
                {adding ? "Saving…" : "Add spend"}
              </Button>
            </div>
          </form>
        )}
        <DataTable
          rows={adSet.spends}
          rowKey={(s) => s.id}
          colorGroupBy={(s) => s.date}
          colorToggleLabel="Color by date"
          empty={{ title: "No spend entries yet" }}
          columns={
            [
              {
                key: "date",
                header: "Date",
                cardTitle: true,
                sortValue: (s) => s.date,
                cell: (s) => <Stamp date={s.date} time={s.time} entered={s.entered} />,
              },
              { key: "paidFrom", header: "Paid from", hideable: true, cell: (s) => s.paidFrom ?? "—" },
              { key: "note", header: "Note", hideable: true, wrap: true, cell: (s) => s.note ?? "—" },
              {
                key: "amount",
                header: "Amount",
                align: "right",
                sortValue: (s) => s.amount,
                cell: (s) => {
                  const over = overBudgetDay(s.date);
                  return (
                    <span
                      className={over ? "font-medium text-destructive" : "font-medium"}
                      title={over ? `Day total ${money(dayTotals.get(s.date) ?? 0)} exceeds daily budget` : undefined}
                    >
                      <Money value={s.amount} />
                      {over && " ↑"}
                    </span>
                  );
                },
              },
              ...(canEdit
                ? [
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      cell: (s: Spend) => (
                        <Button variant="ghost" size="sm" onClick={() => onDeleteSpend(s)}>
                          Delete
                        </Button>
                      ),
                    },
                  ]
                : []),
            ] as Column<Spend>[]
          }
        />
      </CardContent>
    </Card>
  );
}

export function CampaignDetail({
  slug,
  campaign,
  result,
  overlaps,
  window,
  adSets,
  partnerOptions,
  canAdd,
  canEdit,
  canDelete,
}: {
  slug: string;
  campaign: Campaign;
  result: CampaignResult;
  /** Campaigns whose estimate claims the same orders as this one's. */
  overlaps: string[];
  /** The dates the campaign ran, or null before it has any ad set. */
  window: { from: string; to: string | null } | null;
  adSets: AdSet[];
  partnerOptions: PartnerOption[];
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [editStatus, setEditStatus] = useState(campaign.status);
  const [editChannel, setEditChannel] = useState(campaign.channel ?? ANY_CHANNEL);
  const [editLoading, setEditLoading] = useState(false);

  const [adSetOpen, setAdSetOpen] = useState(false);
  const [editingAdSet, setEditingAdSet] = useState<AdSet | null>(null);
  const [adSetStatus, setAdSetStatus] = useState<string>("ACTIVE");
  const [adSetLoading, setAdSetLoading] = useState(false);

  async function onSaveCampaign(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEditLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("status", editStatus);
    fd.set("channel", editChannel === ANY_CHANNEL ? "" : editChannel);
    const res = await updateCampaign(slug, campaign.id, fd);
    setEditLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Campaign updated");
    setEditOpen(false);
    router.refresh();
  }

  function openNewAdSet() {
    setEditingAdSet(null);
    setAdSetStatus("ACTIVE");
    setAdSetOpen(true);
  }

  function openEditAdSet(a: AdSet) {
    setEditingAdSet(a);
    setAdSetStatus(a.status);
    setAdSetOpen(true);
  }

  async function onSaveAdSet(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdSetLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("status", adSetStatus);
    const res = editingAdSet
      ? await updateAdSet(slug, editingAdSet.id, fd)
      : await createAdSet(slug, campaign.id, fd);
    setAdSetLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(editingAdSet ? "Ad set updated" : "Ad set created");
    setAdSetOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Campaign</CardTitle>
          {canEdit && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditStatus(campaign.status);
                setEditChannel(campaign.channel ?? ANY_CHANNEL);
                setEditOpen(true);
              }}
            >
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <div className="text-muted-foreground">Status</div>
              <BoostStatusBadge status={campaign.status} />
            </div>
            <div>
              <div className="text-muted-foreground">Objective</div>
              <div className="font-medium">{campaign.objective ?? "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Channel</div>
              <div className="font-medium">
                {campaign.channel ? orderSourceLabel(campaign.channel) : "Any channel"}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Total spent</div>
              <div className="text-lg font-bold"><Money value={campaign.totalSpent} /></div>
            </div>
            <div>
              <div className="text-muted-foreground">Notes</div>
              <div className="font-medium">{campaign.notes ?? "—"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <ResultsCard
        slug={slug}
        result={result}
        overlaps={overlaps}
        window={window}
        channel={campaign.channel}
      />

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Ad sets</h2>
        {canAdd && <Button onClick={openNewAdSet}>New ad set</Button>}
      </div>

      {adSets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Layers className="size-6" />
            No ad sets yet{canAdd ? " — create one, then add its daily spends." : "."}
          </CardContent>
        </Card>
      ) : (
        adSets.map((a) => (
          <AdSetCard
            key={a.id}
            slug={slug}
            adSet={a}
            partnerOptions={partnerOptions}
            canAdd={canAdd}
            canEdit={canEdit}
            canDelete={canDelete}
            onEdit={() => openEditAdSet(a)}
          />
        ))
      )}

      {/* Edit campaign */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit campaign</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSaveCampaign} className="space-y-4">
            <Field name="name" label="Campaign name" required>
              <Input id="bc-name" name="name" required defaultValue={campaign.name} />
            </Field>
            <Field name="objective" label="Objective (optional)">
              <Input id="bc-objective" name="objective" defaultValue={campaign.objective ?? ""} />
            </Field>
            <div className="space-y-2">
              <Label>Channel</Label>
              <ChannelSelect value={editChannel} onChange={setEditChannel} />
              <p className="text-xs text-muted-foreground">
                Where these ads run. Used to match orders nobody tagged — the
                narrower it is, the better the estimate.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <StatusSelect value={editStatus} onChange={setEditStatus} />
            </div>
            <Field name="notes" label="Notes (optional)">
              <Input id="bc-notes" name="notes" defaultValue={campaign.notes ?? ""} />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={editLoading}>
                {editLoading ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Create / edit ad set */}
      <Dialog open={adSetOpen} onOpenChange={setAdSetOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingAdSet ? "Edit ad set" : "New ad set"}</DialogTitle>
          </DialogHeader>
          <form key={editingAdSet?.id ?? "new"} onSubmit={onSaveAdSet} className="space-y-4">
            <AdSetFormFields adSet={editingAdSet ?? undefined} />
            <div className="space-y-2">
              <Label>Status</Label>
              <StatusSelect value={adSetStatus} onChange={setAdSetStatus} />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={adSetLoading}>
                {adSetLoading
                  ? "Saving…"
                  : editingAdSet
                    ? "Save changes"
                    : "Create ad set"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
