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
import { BoostStatusBadge } from "@/components/boosting/boost-status-badge";

type CampaignRow = {
  id: string;
  name: string;
  objective: string | null;
  status: string;
  adSetCount: number;
  activeAdSets: number;
  totalSpent: number;
  firstStart: string | null;
  lastEnd: string | null;
  openEnded: boolean;
};

const STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
const ALL = "__all__";

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
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState(ALL);

  const filtered = campaigns.filter(
    (c) => statusFilter === ALL || c.status === statusFilter,
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("status", status);
    const res = await createCampaign(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Campaign created");
    setOpen(false);
    setStatus("ACTIVE");
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
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Campaigns</h2>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v ?? ALL)}
          items={[
            { value: ALL, label: "All statuses" },
            ...STATUSES.map((s) => ({ value: s, label: s })),
          ]}
        >
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
