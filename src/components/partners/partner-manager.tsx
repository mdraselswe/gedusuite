"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createPartner,
  updatePartner,
  deletePartner,
} from "@/server/actions/partners";
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
import { Handshake } from "lucide-react";

type PartnerRow = {
  id: string;
  name: string;
  profitSharePercent: number;
  invested: number;
  withdrawn: number;
  expenses: number;
  depositedToTreasury: number;
  netCapital: number;
  remaining: number;
  profitShareAmount: number;
};

export function PartnerManager({
  slug,
  partners,
  memberOptions,
  canManage,
}: {
  slug: string;
  partners: PartnerRow[];
  memberOptions: { userId: string; label: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<PartnerRow | null>(null);
  const [userId, setUserId] = useState("");
  const [loading, setLoading] = useState(false);

  async function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!userId) return toast.error("Select a member");
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("userId", userId);
    const res = await createPartner(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Partner added");
    setAddOpen(false);
    setUserId("");
    router.refresh();
  }

  async function onEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    setLoading(true);
    const res = await updatePartner(slug, editing.id, new FormData(e.currentTarget));
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Partner updated");
    setEditing(null);
    router.refresh();
  }

  async function onDelete(p: PartnerRow) {
    if (!confirm(`Remove partner "${p.name}"? Their transactions will be deleted.`)) return;
    const res = await deletePartner(slug, p.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Partner removed");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAddOpen(true)} disabled={memberOptions.length === 0}>
            + Add partner
          </Button>
        </div>
      )}

      <DataTable
        rows={partners}
        rowKey={(p) => p.id}
        empty={{
          icon: Handshake,
          title: "No partners yet",
          description: canManage ? "Promote a member to partner to track investment & profit share." : undefined,
        }}
        columns={
          [
            { key: "name", header: "Partner", cardTitle: true, cell: (p) => p.name },
            {
              key: "share",
              header: "Share %",
              align: "right",
              cell: (p) => p.profitSharePercent.toFixed(2),
            },
            {
              key: "capital",
              header: "Net capital",
              align: "right",
              cell: (p) => p.netCapital.toFixed(2),
            },
            {
              key: "expenses",
              header: "Expenses",
              align: "right",
              cell: (p) => p.expenses.toFixed(2),
            },
            {
              key: "remaining",
              header: "Remaining",
              align: "right",
              cell: (p) => (
                <span className={p.remaining < 0 ? "text-destructive" : undefined}>
                  {p.remaining.toFixed(2)}
                </span>
              ),
            },
            {
              key: "toTreasury",
              header: "To treasury",
              align: "right",
              cell: (p) => p.depositedToTreasury.toFixed(2),
            },
            {
              key: "profitShare",
              header: "Profit share",
              align: "right",
              cell: (p) => p.profitShareAmount.toFixed(2),
            },
            {
              key: "actions",
              header: "",
              cardFullWidth: true,
              cell: (p: PartnerRow) => (
                <>
                  <Link
                    href={`/${slug}/partners/${p.id}`}
                    className="inline-flex items-center text-sm underline underline-offset-4"
                  >
                    Ledger
                  </Link>
                  {canManage && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(p)}>
                        Remove
                      </Button>
                    </>
                  )}
                </>
              ),
            },
          ] as Column<PartnerRow>[]
        }
      />

      {/* Add partner */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add partner</DialogTitle>
          </DialogHeader>
          <form onSubmit={onAdd} className="space-y-4">
            <div className="space-y-2">
              <Label>Member</Label>
              <Select
                value={userId}
                onValueChange={(v) => setUserId(v ?? "")}
                items={memberOptions.map((m) => ({ value: m.userId, label: m.label }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a member" />
                </SelectTrigger>
                <SelectContent>
                  {memberOptions.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="a-share">Profit share %</Label>
              <Input id="a-share" name="profitSharePercent" type="number" step="0.01" min="0" max="100" defaultValue="0" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="a-notes">Notes</Label>
              <Input id="a-notes" name="notes" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading ? "Saving…" : "Add partner"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit partner */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          <form key={editing?.id ?? "new"} onSubmit={onEdit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="e-share">Profit share %</Label>
              <Input
                id="e-share"
                name="profitSharePercent"
                type="number"
                step="0.01"
                min="0"
                max="100"
                defaultValue={editing?.profitSharePercent ?? 0}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={loading}>
                {loading ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
