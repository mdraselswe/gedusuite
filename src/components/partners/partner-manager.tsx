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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type PartnerRow = {
  id: string;
  name: string;
  profitSharePercent: number;
  invested: number;
  withdrawn: number;
  expenses: number;
  depositedToTreasury: number;
  netCapital: number;
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

      {partners.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No partners yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Partner</TableHead>
              <TableHead className="text-right">Share %</TableHead>
              <TableHead className="text-right">Net capital</TableHead>
              <TableHead className="text-right">Expenses</TableHead>
              <TableHead className="text-right">To treasury</TableHead>
              <TableHead className="text-right">Profit share</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {partners.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="text-right">{p.profitSharePercent.toFixed(2)}</TableCell>
                <TableCell className="text-right">{p.netCapital.toFixed(2)}</TableCell>
                <TableCell className="text-right">{p.expenses.toFixed(2)}</TableCell>
                <TableCell className="text-right">{p.depositedToTreasury.toFixed(2)}</TableCell>
                <TableCell className="text-right font-medium">
                  {p.profitShareAmount.toFixed(2)}
                </TableCell>
                <TableCell className="flex gap-1">
                  <Link
                    href={`/${slug}/partners/${p.id}`}
                    className="text-sm underline underline-offset-4"
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Add partner */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add partner</DialogTitle>
          </DialogHeader>
          <form onSubmit={onAdd} className="space-y-4">
            <div className="space-y-2">
              <Label>Member</Label>
              <Select value={userId} onValueChange={(v) => setUserId(v ?? "")}>
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
