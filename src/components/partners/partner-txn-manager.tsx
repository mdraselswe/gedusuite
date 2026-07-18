"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createPartnerTxn, deletePartnerTxn } from "@/server/actions/partners";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

type Txn = {
  id: string;
  date: string;
  type: string;
  amount: number;
  purpose: string | null;
};

const TYPES = ["INVESTMENT", "EXPENSE", "WITHDRAWAL", "DEPOSIT_TO_TREASURY"];
const LABEL: Record<string, string> = {
  INVESTMENT: "Investment",
  EXPENSE: "Expense",
  WITHDRAWAL: "Withdrawal",
  DEPOSIT_TO_TREASURY: "Deposit to treasury",
};

export function PartnerTxnManager({
  slug,
  partnerId,
  txns,
  canAdd,
  canDelete,
}: {
  slug: string;
  partnerId: string;
  txns: Txn[];
  canAdd: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [type, setType] = useState("INVESTMENT");
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("partnerId", partnerId);
    fd.set("type", type);
    const res = await createPartnerTxn(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Transaction added");
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this transaction?")) return;
    const res = await deletePartnerTxn(slug, id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Transaction deleted");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {canAdd && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add transaction</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-4">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={type} onValueChange={(v) => setType(v ?? "INVESTMENT")}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="t-amount">Amount</Label>
                <Input id="t-amount" name="amount" type="number" step="0.01" min="0" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="t-date">Date</Label>
                <Input id="t-date" name="date" type="date" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="t-purpose">Purpose</Label>
                <Input id="t-purpose" name="purpose" />
              </div>
              <div className="sm:col-span-4">
                <Button type="submit" disabled={loading}>
                  {loading ? "Saving…" : "Add transaction"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="mb-3 text-lg font-semibold">Transaction log</h2>
        {txns.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No transactions.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                {canDelete && <TableHead className="w-16" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {txns.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.date}</TableCell>
                  <TableCell>{LABEL[t.type] ?? t.type}</TableCell>
                  <TableCell>{t.purpose ?? "—"}</TableCell>
                  <TableCell className="text-right">{t.amount.toFixed(2)}</TableCell>
                  {canDelete && (
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(t.id)}>
                        Delete
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
