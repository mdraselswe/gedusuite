"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
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
import { DataTable, type Column } from "@/components/ui/data-table";
import { ArrowLeftRight } from "lucide-react";

type Txn = {
  id: string;
  date: string;
  type: string;
  amount: number;
  purpose: string | null;
  fromDistribution: boolean;
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
    const ok = await confirmDialog({
      title: "Delete transaction?",
      description: "This partner transaction will be permanently removed.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
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
        <DataTable
          rows={txns}
          rowKey={(t) => t.id}
          searchText={(t) => `${t.type} ${t.purpose ?? ""}`}
          searchPlaceholder="Search type, purpose…"
          empty={{ icon: ArrowLeftRight, title: "No transactions" }}
          columns={
            [
              { key: "date", header: "Date", sortValue: (t) => t.date, cell: (t) => t.date },
              {
                key: "type",
                header: "Type",
                cardTitle: true,
                cell: (t) => LABEL[t.type] ?? t.type,
              },
              { key: "purpose", header: "Purpose", hideable: true, wrap: true, cell: (t) => t.purpose ?? "—" },
              {
                key: "amount",
                header: "Amount",
                sortValue: (t) => t.amount,
                align: "right",
                cell: (t) => t.amount.toFixed(2),
              },
              ...(canDelete
                ? [
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      cell: (t: Txn) =>
                        t.fromDistribution ? (
                          <span className="text-xs text-muted-foreground">from distribution</span>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => onDelete(t.id)}>
                            Delete
                          </Button>
                        ),
                    },
                  ]
                : []),
            ] as Column<Txn>[]
          }
        />
      </div>
    </div>
  );
}
