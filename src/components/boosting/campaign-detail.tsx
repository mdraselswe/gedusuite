"use client";

import { useState } from "react";
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

type Spend = {
  id: string;
  date: string;
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
  status: string;
  notes: string | null;
  totalSpent: number;
};

const STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
const NONE = "__none__";
const TREASURY = "__treasury__";

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

function AdSetFormFields({ adSet }: { adSet?: AdSet }) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="as-name">Ad set name</Label>
        <Input
          id="as-name"
          name="name"
          required
          defaultValue={adSet?.name}
          placeholder="e.g. Dhaka 25-40 women"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="as-start">Start date</Label>
          <Input
            id="as-start"
            name="startDate"
            type="date"
            required
            defaultValue={adSet?.startDate ?? todayLocal()}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="as-end">End date (optional)</Label>
          <Input id="as-end" name="endDate" type="date" defaultValue={adSet?.endDate ?? ""} />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="as-budget">Daily budget (optional)</Label>
        <Input
          id="as-budget"
          name="dailyBudget"
          type="number"
          step="0.01"
          min="0"
          defaultValue={adSet?.dailyBudget ?? ""}
          placeholder="Facebook-e set kora per-day budget"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="as-notes">Notes (optional)</Label>
        <Input id="as-notes" name="notes" defaultValue={adSet?.notes ?? ""} />
      </div>
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
  // Sticky across entries — daily spends for an ad set almost always come off
  // the same card, so keep the last choice selected after submit.
  const [paidFrom, setPaidFrom] = useState<string>(NONE);

  // A day is over budget when that single day's charge exceeds the ad set's
  // Facebook daily budget (small overshoot is normal — FB can spend up to
  // ~125% of daily on a given day — but it's still worth surfacing).
  const overBudgetDays =
    adSet.dailyBudget !== null
      ? adSet.spends.filter((s) => s.amount > adSet.dailyBudget!).length
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
          {adSet.dailyBudget !== null && <span>Daily budget: {adSet.dailyBudget.toFixed(2)}</span>}
          <span>
            Spent: <span className="font-medium text-foreground">{adSet.totalSpent.toFixed(2)}</span>
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
                type="date"
                required
                defaultValue={todayLocal()}
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
          empty={{ title: "No spend entries yet" }}
          columns={
            [
              { key: "date", header: "Date", cardTitle: true, sortValue: (s) => s.date, cell: (s) => s.date },
              { key: "paidFrom", header: "Paid from", hideable: true, cell: (s) => s.paidFrom ?? "—" },
              { key: "note", header: "Note", hideable: true, wrap: true, cell: (s) => s.note ?? "—" },
              {
                key: "amount",
                header: "Amount",
                align: "right",
                sortValue: (s) => s.amount,
                cell: (s) => {
                  const over = adSet.dailyBudget !== null && s.amount > adSet.dailyBudget;
                  return (
                    <span className={over ? "font-medium text-destructive" : "font-medium"}>
                      {s.amount.toFixed(2)}
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
  adSets,
  partnerOptions,
  canAdd,
  canEdit,
  canDelete,
}: {
  slug: string;
  campaign: Campaign;
  adSets: AdSet[];
  partnerOptions: PartnerOption[];
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [editStatus, setEditStatus] = useState(campaign.status);
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
                setEditOpen(true);
              }}
            >
              Edit
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-muted-foreground">Status</div>
              <BoostStatusBadge status={campaign.status} />
            </div>
            <div>
              <div className="text-muted-foreground">Objective</div>
              <div className="font-medium">{campaign.objective ?? "—"}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Total spent</div>
              <div className="text-lg font-bold">{campaign.totalSpent.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Notes</div>
              <div className="font-medium">{campaign.notes ?? "—"}</div>
            </div>
          </div>
        </CardContent>
      </Card>

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
            <div className="space-y-2">
              <Label htmlFor="bc-name">Campaign name</Label>
              <Input id="bc-name" name="name" required defaultValue={campaign.name} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bc-objective">Objective (optional)</Label>
              <Input id="bc-objective" name="objective" defaultValue={campaign.objective ?? ""} />
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <StatusSelect value={editStatus} onChange={setEditStatus} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bc-notes">Notes (optional)</Label>
              <Input id="bc-notes" name="notes" defaultValue={campaign.notes ?? ""} />
            </div>
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
