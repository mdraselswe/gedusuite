"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Megaphone } from "lucide-react";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { createCampaign, deleteCampaign } from "@/server/actions/boosting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useFilterBar, type FilterDef } from "@/components/ui/filter-bar";
import { BoostStatusBadge } from "@/components/boosting/boost-status-badge";
import { ORDER_SOURCES, ORDER_SOURCE_LABEL, orderSourceLabel } from "@/lib/order-source";
import { cn } from "@/lib/utils";

type CampaignRow = {
  id: string;
  name: string;
  objective: string | null;
  channel: string | null;
  status: string;
  adSetCount: number;
  activeAdSets: number;
  totalSpent: number;
  firstStart: string | null;
  lastEnd: string | null;
  openEnded: boolean;
  /** Whether the numbers below came from tagged orders or a window guess. */
  basis: "TAGGED" | "ESTIMATED" | "NONE";
  orders: number;
  revenue: number;
  profitAfterAds: number;
  roas: number | null;
  /** Profit ÷ revenue on the attributed orders, 0–1. */
  margin: number | null;
  /** The ROAS this campaign's own margin needs just to pay for the ads. */
  breakEvenRoas: number | null;
  roasTone: "good" | "bad" | null;
};

const STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
/** "Any channel" in the campaign form — the estimate then doesn't narrow. */
const ANY_CHANNEL = "__any__";

export function BoostingManager({
  slug,
  campaigns,
  canAdd,
  canDelete,
}: {
  slug: string;
  campaigns: CampaignRow[];
  canAdd: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string>("ACTIVE");
  const [channel, setChannel] = useState<string>(ANY_CHANNEL);
  const [loading, setLoading] = useState(false);
  const filters: FilterDef<CampaignRow>[] = [
    {
      key: "status",
      label: "All statuses",
      kind: "select",
      primary: true,
      options: STATUSES.map((st) => ({ value: st, label: st })),
      match: (c, v) => c.status === v,
    },
    {
      key: "objective",
      label: "Objective",
      kind: "select",
      options: [...new Set(campaigns.map((c) => c.objective).filter((o): o is string => !!o))].map(
        (o) => ({ value: o, label: o }),
      ),
      match: (c, v) => c.objective === v,
    },
    {
      key: "running",
      label: "Ad sets",
      kind: "select",
      options: [
        { value: "active", label: "Has active ad sets" },
        { value: "idle", label: "Nothing running" },
      ],
      match: (c, v) => (v === "active" ? c.activeAdSets > 0 : c.activeAdSets === 0),
    },
    { key: "spend", label: "Total spent", kind: "numberRange", value: (c) => c.totalSpent },
    {
      key: "started",
      label: "First started",
      kind: "dateRange",
      // Campaigns with no ad set yet have no start date; an unstarted
      // campaign shouldn't survive a "started between" filter.
      value: (c) => c.firstStart ?? "",
    },
  ];

  const { rows: filtered, bar } = useFilterBar(campaigns, filters, {
    summary: (shown) => (
      <span className="text-muted-foreground">
        Spent{" "}
        <span className="font-semibold text-foreground tabular-nums">
          {shown.reduce((s, c) => s + c.totalSpent, 0).toFixed(2)}
        </span>
      </span>
    ),
  });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("status", status);
    fd.set("channel", channel === ANY_CHANNEL ? "" : channel);
    const res = await createCampaign(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Campaign created");
    setOpen(false);
    setStatus("ACTIVE");
    setChannel(ANY_CHANNEL);
    if (res.id) router.push(`/${slug}/boosting/${res.id}`);
    else router.refresh();
  }

  async function onDelete(c: CampaignRow) {
    const ok = await confirmDialog({
      title: `Delete "${c.name}"?`,
      description:
        "All its ad sets and daily spend entries will be removed, along with any linked treasury deductions and partner investment credits.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteCampaign(slug, c.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Campaign deleted");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <h2 className="mr-auto text-lg font-semibold">Campaigns</h2>
        <div className="min-w-0">{bar}</div>
        {canAdd && <Button onClick={() => setOpen(true)}>New campaign</Button>}
      </div>

      <DataTable
        rows={filtered}
        rowKey={(c) => c.id}
        searchText={(c) => `${c.name} ${c.objective ?? ""}`}
        searchPlaceholder="Search campaigns…"
        empty={{
          icon: Megaphone,
          title: "No campaigns yet",
          description: canAdd ? "Create one to start tracking daily boosting spend." : undefined,
        }}
        columns={
          [
            {
              key: "name",
              header: "Campaign",
              cardTitle: true,
              wrap: true,
              sortValue: (c) => c.name,
              cell: (c) => (
                <Link
                  href={`/${slug}/boosting/${c.id}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {c.name}
                </Link>
              ),
            },
            {
              key: "objective",
              header: "Objective",
              hideable: true,
              cell: (c) => c.objective ?? "—",
            },
            {
              key: "channel",
              header: "Channel",
              hideable: true,
              cell: (c) =>
                c.channel ? (
                  orderSourceLabel(c.channel)
                ) : (
                  <span className="text-muted-foreground">Any</span>
                ),
            },
            {
              key: "status",
              header: "Status",
              cell: (c) => <BoostStatusBadge status={c.status} />,
            },
            {
              key: "adSets",
              header: "Ad sets",
              align: "right",
              cell: (c) =>
                c.adSetCount === 0 ? "—" : `${c.activeAdSets} active / ${c.adSetCount}`,
            },
            {
              key: "period",
              header: "Period",
              hideable: true,
              cell: (c) =>
                c.firstStart
                  ? `${c.firstStart} → ${c.openEnded ? "running" : (c.lastEnd ?? "—")}`
                  : "—",
            },
            {
              key: "spent",
              header: "Total spent",
              align: "right",
              sortValue: (c) => c.totalSpent,
              cell: (c) => <span className="font-medium">{c.totalSpent.toFixed(2)}</span>,
            },
            {
              key: "orders",
              header: "Orders",
              align: "right",
              hideable: true,
              sortValue: (c) => c.orders,
              cell: (c) => (c.basis === "NONE" ? "—" : c.orders),
            },
            {
              key: "revenue",
              header: "Revenue",
              align: "right",
              hideable: true,
              sortValue: (c) => c.revenue,
              cell: (c) => (c.basis === "NONE" ? "—" : c.revenue.toFixed(2)),
            },
            {
              key: "margin",
              header: "Margin",
              align: "right",
              hideable: true,
              sortValue: (c) => c.margin ?? -1,
              cell: (c) => (c.margin === null ? "—" : `${(c.margin * 100).toFixed(1)}%`),
            },
            {
              key: "roas",
              header: "ROAS",
              align: "right",
              // Sorted by how far above or below its own break-even a campaign
              // is, not by raw ROAS: 2.45× on a thin margin is worse than
              // 1.80× on a fat one, and the column would otherwise rank them
              // the wrong way round.
              sortValue: (c) =>
                c.roas === null ? -1 : c.breakEvenRoas ? c.roas / c.breakEvenRoas : 0,
              // An estimated figure is marked with ~ rather than given its own
              // column: the number is the same kind of thing either way, it's
              // just less certain, and a legend beats a second column here.
              cell: (c) =>
                c.roas === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className="inline-flex flex-col items-end">
                    <span
                      className={cn(
                        "font-medium tabular-nums",
                        c.roasTone === "good" && "text-emerald-600 dark:text-emerald-400",
                        c.roasTone === "bad" && "text-destructive",
                      )}
                      title={
                        c.basis === "ESTIMATED"
                          ? "Estimated from the campaign's dates and channel — no orders tagged to it"
                          : "From orders tagged to this campaign"
                      }
                    >
                      {c.basis === "ESTIMATED" && "~"}
                      {c.roas.toFixed(2)}×
                    </span>
                    {/* Break-even rides along with the number, so nobody reads
                        2.45× as a win on a 27% margin. */}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {c.breakEvenRoas === null
                        ? "no profit"
                        : `break-even ${c.breakEvenRoas.toFixed(2)}×`}
                    </span>
                  </span>
                ),
            },
            {
              key: "profitAfterAds",
              header: "Profit after ads",
              align: "right",
              hideable: true,
              sortValue: (c) => c.profitAfterAds,
              cell: (c) =>
                c.basis === "NONE" ? (
                  "—"
                ) : (
                  <span
                    className={cn(
                      "font-medium tabular-nums",
                      c.profitAfterAds >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive",
                    )}
                  >
                    {c.profitAfterAds.toFixed(2)}
                  </span>
                ),
            },
            ...(canDelete
              ? [
                  {
                    key: "actions",
                    header: "",
                    cardFullWidth: true,
                    cell: (c: CampaignRow) => (
                      <Button variant="ghost" size="sm" onClick={() => onDelete(c)}>
                        Delete
                      </Button>
                    ),
                  },
                ]
              : []),
          ] as Column<CampaignRow>[]
        }
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New campaign</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bc-name">Campaign name</Label>
              <Input id="bc-name" name="name" required placeholder="e.g. Eid collection boost" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bc-objective">Objective (optional)</Label>
              <Input id="bc-objective" name="objective" placeholder="Message, Engagement, Sales…" />
            </div>
            <div className="space-y-2">
              <Label>Channel</Label>
              <Select
                value={channel}
                onValueChange={(v) => setChannel(v ?? ANY_CHANNEL)}
                items={[
                  { value: ANY_CHANNEL, label: "Any channel" },
                  ...ORDER_SOURCES.map((s) => ({ value: s, label: ORDER_SOURCE_LABEL[s] })),
                ]}
              >
                <SelectTrigger className="w-full">
                  <span data-slot="select-value">
                    {channel === ANY_CHANNEL ? "Any channel" : orderSourceLabel(channel)}
                  </span>
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
              <p className="text-xs text-muted-foreground">
                Where the ads run — used to work out which orders this campaign
                brought in when nobody tagged them.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v ?? "ACTIVE")}>
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
            </div>
            <div className="space-y-2">
              <Label htmlFor="bc-notes">Notes (optional)</Label>
              <Input id="bc-notes" name="notes" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading ? "Creating…" : "Create campaign"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
