"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createTreasuryEntry,
  deleteTreasuryEntry,
} from "@/server/actions/treasury";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Wallet } from "lucide-react";

type Entry = {
  id: string;
  date: string;
  type: string;
  amount: number;
  source: string;
  note: string | null;
  partnerName: string | null;
  fromDeposit: boolean;
};
type Overdue = {
  orderId: string;
  date: string;
  daysOverdue: number;
  amount: number;
  customerName: string;
  heldByName: string | null;
};
const ALL = "__all__";
const NONE = "__none__";

export function TreasuryManager({
  slug,
  entries,
  partnerOptions,
  overdue,
  canManage,
}: {
  slug: string;
  balance: number;
  entries: Entry[];
  partnerOptions: { id: string; label: string }[];
  overdue: Overdue[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [type, setType] = useState("IN");
  const [partnerId, setPartnerId] = useState(NONE);
  const [loading, setLoading] = useState(false);

  // Filters
  const [dirFilter, setDirFilter] = useState(ALL);
  const [partnerFilter, setPartnerFilter] = useState(ALL);

  const filtered = entries.filter((e) => {
    if (dirFilter !== ALL && e.type !== dirFilter) return false;
    if (partnerFilter !== ALL) {
      const match = partnerOptions.find((p) => p.id === partnerFilter);
      if (!match || e.partnerName !== match.label) return false;
    }
    return true;
  });

  const totalOverdue = overdue.reduce((s, o) => s + o.amount, 0);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("type", type);
    fd.set("partnerId", partnerId === NONE ? "" : partnerId);
    const res = await createTreasuryEntry(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Entry added");
    (e.target as HTMLFormElement).reset();
    setPartnerId(NONE);
    router.refresh();
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this entry?")) return;
    const res = await deleteTreasuryEntry(slug, id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Entry deleted");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Overdue receivables */}
      {overdue.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader>
            <CardTitle className="text-base text-amber-800 dark:text-amber-300">
              Overdue receivables — {totalOverdue.toFixed(2)} across {overdue.length} order(s)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={overdue}
              rowKey={(o) => o.orderId}
              empty={{ title: "No overdue payments" }}
              columns={
                [
                  { key: "date", header: "Date", cell: (o) => o.date },
                  {
                    key: "customer",
                    header: "Customer",
                    cardTitle: true,
                    cell: (o) => o.customerName,
                  },
                  { key: "heldBy", header: "Held by", cell: (o) => o.heldByName ?? "—" },
                  { key: "days", header: "Days", align: "right", cell: (o) => o.daysOverdue },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (o) => (
                      <span className="font-medium text-destructive">{o.amount.toFixed(2)}</span>
                    ),
                  },
                ] as Column<Overdue>[]
              }
            />
          </CardContent>
        </Card>
      )}

      {/* Add entry */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add treasury entry</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label>Direction</Label>
                <Select value={type} onValueChange={(v) => setType(v ?? "IN")}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IN">IN</SelectItem>
                    <SelectItem value="OUT">OUT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="te-amount">Amount</Label>
                <Input id="te-amount" name="amount" type="number" step="0.01" min="0" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="te-date">Date</Label>
                <Input id="te-date" name="date" type="date" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="te-source">Source</Label>
                <Input id="te-source" name="source" required placeholder="Sales, Rent, …" />
              </div>
              <div className="space-y-2">
                <Label>Partner (optional)</Label>
                <Select value={partnerId} onValueChange={(v) => setPartnerId(v ?? NONE)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>—</SelectItem>
                    {partnerOptions.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="te-note">Note</Label>
                <Input id="te-note" name="note" />
              </div>
              <div className="sm:col-span-3">
                <Button type="submit" disabled={loading}>
                  {loading ? "Saving…" : "Add entry"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Ledger + filters */}
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">Ledger</h2>
          <Select value={dirFilter} onValueChange={(v) => setDirFilter(v ?? ALL)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              <SelectItem value="IN">IN</SelectItem>
              <SelectItem value="OUT">OUT</SelectItem>
            </SelectContent>
          </Select>
          <Select value={partnerFilter} onValueChange={(v) => setPartnerFilter(v ?? ALL)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All partners</SelectItem>
              {partnerOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DataTable
          rows={filtered}
          rowKey={(e) => e.id}
          empty={{ icon: Wallet, title: "No entries" }}
          columns={
            [
              { key: "date", header: "Date", cell: (e) => e.date },
              {
                key: "dir",
                header: "Dir",
                cell: (e) => (
                  <Badge variant={e.type === "IN" ? "secondary" : "outline"}>{e.type}</Badge>
                ),
              },
              { key: "source", header: "Source", cardTitle: true, cell: (e) => e.source },
              { key: "partner", header: "Partner", cell: (e) => e.partnerName ?? "—" },
              { key: "note", header: "Note", cell: (e) => e.note ?? "—" },
              {
                key: "amount",
                header: "Amount",
                align: "right",
                cell: (e) => (
                  <span className={e.type === "IN" ? "text-green-600" : "text-destructive"}>
                    {e.type === "IN" ? "+" : "−"}
                    {e.amount.toFixed(2)}
                  </span>
                ),
              },
              ...(canManage
                ? [
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      cell: (e: Entry) =>
                        e.fromDeposit ? (
                          <span className="text-xs text-muted-foreground">from deposit</span>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => onDelete(e.id)}>
                            Delete
                          </Button>
                        ),
                    },
                  ]
                : []),
            ] as Column<Entry>[]
          }
        />
      </div>
    </div>
  );
}
