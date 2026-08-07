"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { createPartnerTxn, deletePartnerTxn } from "@/server/actions/partners";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useFilterBar, type FilterDef } from "@/components/ui/filter-bar";
import type { DerivedKind } from "@/lib/partner-credit";
import { MANUAL, SOURCE_OPTIONS, totalsByType } from "@/lib/partner-ledger-filters";
import { ArrowLeftRight } from "lucide-react";
import { Money } from "@/components/ui/money";

type Txn = {
  id: string;
  date: string;
  type: string;
  amount: number;
  purpose: string | null;
  /** "from boosting", "from internal purchase", … — null when hand-entered. */
  derivedFrom: string | null;
  /** Stable counterpart to derivedFrom, for filtering. Null when hand-entered. */
  derivedKind: DerivedKind | null;
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
  const [fromTreasury, setFromTreasury] = useState(false);
  const [loading, setLoading] = useState(false);
  const filters: FilterDef<Txn>[] = [
    {
      key: "type",
      label: "Any type",
      kind: "select",
      primary: true,
      options: TYPES.map((t) => ({ value: t, label: LABEL[t] })),
      match: (t, v) => t.type === v,
    },
    {
      key: "source",
      label: "Source",
      kind: "select",
      options: SOURCE_OPTIONS,
      // "Hand-entered" is a real answer, not the absence of one.
      match: (t, v) => (v === MANUAL ? t.derivedKind === null : t.derivedKind === v),
    },
    { key: "date", label: "Date range", kind: "dateRange", value: (t) => t.date },
    { key: "amount", label: "Amount", kind: "numberRange", value: (t) => t.amount },
  ];

  const { rows, bar, active } = useFilterBar(txns, filters, {
    // A ledger's filters only pay off if they answer "how much" — per type,
    // because investments and withdrawals summed together mean nothing.
    summary: (shown) =>
      [...totalsByType(shown)].map(([type, total]) => (
        <span key={type} className="text-muted-foreground">
          {LABEL[type] ?? type}{" "}
          <span className="font-semibold text-foreground tabular-nums"><Money value={total} /></span>
        </span>
      )),
  });

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
    // form.reset() only clears the native inputs; the tick is React state.
    setFromTreasury(false);
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
                <Select
                  value={type}
                  onValueChange={(v) => {
                    setType(v ?? "INVESTMENT");
                    // Switching away from Withdrawal hides the tick; clearing it
                    // stops a stale one being submitted if they switch back.
                    if (v !== "WITHDRAWAL") setFromTreasury(false);
                  }}
                >
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
              {/* Only a withdrawal can come out of the treasury. An investment
                  and a deposit both put money in, and a manual expense is the
                  partner's own money by definition — that's what makes it
                  theirs to be reimbursed for. */}
              {type === "WITHDRAWAL" && (
                <div className="space-y-2 sm:col-span-4">
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={fromTreasury}
                      onCheckedChange={(v) => setFromTreasury(v === true)}
                    />
                    <span>
                      Taken out of the treasury
                      <span className="block text-xs text-muted-foreground">
                        Writes the matching OUT entry so the treasury balance drops with it.
                        Leave unticked if this was cash held somewhere else — the treasury
                        never had it, so nothing should come off it.
                      </span>
                    </span>
                  </label>
                </div>
              )}
              <input type="hidden" name="fromTreasury" value={String(type === "WITHDRAWAL" && fromTreasury)} />
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
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Transaction log</h2>
        </div>
        <div className="mb-3">{bar}</div>

        <DataTable
          rows={rows}
          rowKey={(t) => t.id}
          colorGroupBy={(t) => t.date}
          colorToggleLabel="Color by date"
          searchText={(t) => `${t.type} ${t.purpose ?? ""}`}
          searchPlaceholder="Search type, purpose…"
          empty={{
            icon: ArrowLeftRight,
            title: active > 0 ? "No transactions match these filters" : "No transactions",
          }}
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
                cell: (t) => <Money value={t.amount} />,
              },
              ...(canDelete
                ? [
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      // A derived row is edited through its source, never here.
                      cell: (t: Txn) =>
                        t.derivedFrom ? (
                          <span className="text-xs text-muted-foreground">{t.derivedFrom}</span>
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
