"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  createTreasuryEntry,
  deleteTreasuryEntry,
} from "@/server/actions/treasury";
import { markCashDeposited, unmarkCashDeposited } from "@/server/actions/cash-custody";
import { createDistribution, deleteDistribution } from "@/server/actions/distributions";
import { splitByShare } from "@/lib/profit-share";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { useFilterBar, type FilterDef } from "@/components/ui/filter-bar";
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
  fromOrder: boolean;
  fromPurchase: boolean;
  fromDistribution: boolean;
  fromBoost: boolean;
};
type SharePartner = { id: string; label: string; percent: number };
type Distribution = {
  id: string;
  date: string;
  totalAmount: number;
  note: string | null;
};
type Overdue = {
  orderId: string;
  date: string;
  daysOverdue: number;
  amount: number;
  customerName: string;
  heldByName: string | null;
};
type HeldCash = {
  membershipId: string;
  holderName: string;
  amount: number;
  orderCount: number;
};
type NotDeposited = {
  orderId: string;
  date: string;
  customerName: string;
  amount: number;
  paymentMethod: string;
  heldByName: string | null;
  isCourierCollection: boolean;
};
const NONE = "__none__";

export function TreasuryManager({
  slug,
  balance,
  entries,
  partnerOptions,
  sharePartners,
  distributions,
  overdue,
  heldCash,
  notDeposited,
  distributableProfit,
  canManage,
}: {
  slug: string;
  balance: number;
  entries: Entry[];
  partnerOptions: { id: string; label: string }[];
  sharePartners: SharePartner[];
  distributions: Distribution[];
  overdue: Overdue[];
  heldCash: HeldCash[];
  notDeposited: NotDeposited[];
  /** What the business actually earned — the other half of "can we take money out?". */
  distributableProfit: number;
  canManage: boolean;
}) {
  const router = useRouter();
  const [depositing, setDepositing] = useState<string | null>(null);
  const [distOpen, setDistOpen] = useState(false);
  const [distAmount, setDistAmount] = useState("");
  const [distLoading, setDistLoading] = useState(false);

  const totalPercent = sharePartners.reduce((s, p) => s + p.percent, 0);
  const distAmountNum = parseFloat(distAmount) || 0;
  // splitByShare, not a fourth copy of the same arithmetic — the preview has to
  // be what actually gets paid, down to the rounding remainder.
  const preview = splitByShare(sharePartners, distAmountNum);
  // How much of this isn't profit. Cash and profit are different questions and
  // only cash was ever asked; this is the other one, asked before it matters.
  const beyondProfit = Math.round((distAmountNum - Math.max(0, distributableProfit)) * 100) / 100;

  async function onSubmitDistribution(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setDistLoading(true);
    let res = await createDistribution(slug, fd);
    // The server asks rather than refuses when the amount goes past profit:
    // taking capital out is a decision partners may make, just not by accident.
    if (!res.ok && "confirm" in res) {
      setDistLoading(false);
      const ok = await confirmDialog({
        title: "Take this out anyway?",
        description: res.error,
        confirmText: "Distribute anyway",
        destructive: true,
      });
      if (!ok) return;
      fd.set("confirmBeyondProfit", "true");
      setDistLoading(true);
      res = await createDistribution(slug, fd);
    }
    setDistLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Distributed to partners");
    setDistOpen(false);
    setDistAmount("");
    router.refresh();
  }

  async function onDeleteDistribution(id: string) {
    const ok = await confirmDialog({
      title: "Delete distribution?",
      description: "Every partner's share from this distribution will be removed too.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteDistribution(slug, id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Distribution deleted");
    router.refresh();
  }
  const withCourier = notDeposited.filter((o) => o.isCourierCollection);
  const withMembers = notDeposited.filter((o) => !o.isCourierCollection);
  const courierTotal = withCourier.reduce((s, o) => s + o.amount, 0);
  const membersTotal = withMembers.reduce((s, o) => s + o.amount, 0);

  async function onMarkDeposited(orderId: string) {
    setDepositing(orderId);
    const res = await markCashDeposited(slug, orderId);
    setDepositing(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Marked as deposited to treasury");
    router.refresh();
  }

  async function onUnmarkDeposited(orderId: string) {
    const ok = await confirmDialog({
      title: "Undo deposit?",
      description: "The linked treasury entry will be removed.",
      confirmText: "Undo",
      destructive: true,
    });
    if (!ok) return;
    setDepositing(orderId);
    const res = await unmarkCashDeposited(slug, orderId);
    setDepositing(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Undone");
    router.refresh();
  }
  const [type, setType] = useState("IN");
  const [partnerId, setPartnerId] = useState(NONE);
  const [loading, setLoading] = useState(false);

  const filters: FilterDef<Entry>[] = [
    {
      key: "direction",
      label: "In and out",
      kind: "select",
      primary: true,
      options: [
        { value: "IN", label: "IN" },
        { value: "OUT", label: "OUT" },
      ],
      match: (e, v) => e.type === v,
    },
    {
      key: "partner",
      label: "Partner",
      kind: "select",
      primary: true,
      options: partnerOptions.map((p) => ({ value: p.id, label: p.label })),
      // Entries carry the partner's name, not their id — match through the
      // options list rather than denormalising the row.
      match: (e, v) => e.partnerName === partnerOptions.find((p) => p.id === v)?.label,
    },
    {
      key: "origin",
      label: "Where it came from",
      kind: "select",
      options: [
        { value: "manual", label: "Entered by hand" },
        { value: "deposit", label: "Partner deposit" },
        { value: "order", label: "Order cash" },
        { value: "purchase", label: "Purchase" },
        { value: "distribution", label: "Profit distribution" },
        { value: "boost", label: "Boosting" },
      ],
      match: (e, v) => {
        if (v === "manual") {
          return !e.fromDeposit && !e.fromOrder && !e.fromPurchase && !e.fromDistribution && !e.fromBoost;
        }
        if (v === "deposit") return e.fromDeposit;
        if (v === "order") return e.fromOrder;
        if (v === "purchase") return e.fromPurchase;
        if (v === "distribution") return e.fromDistribution;
        return e.fromBoost;
      },
    },
    { key: "date", label: "Date range", kind: "dateRange", value: (e) => e.date },
    { key: "amount", label: "Amount", kind: "numberRange", value: (e) => e.amount },
  ];

  const { rows: filtered, bar, active } = useFilterBar(entries, filters, {
    // Net is the number a treasury ledger is actually read for.
    summary: (shown) => {
      const inSum = shown.filter((e) => e.type === "IN").reduce((s, e) => s + e.amount, 0);
      const outSum = shown.filter((e) => e.type === "OUT").reduce((s, e) => s + e.amount, 0);
      return (
        <>
          <span className="text-muted-foreground">
            In <span className="font-semibold text-foreground tabular-nums">{inSum.toFixed(2)}</span>
          </span>
          <span className="text-muted-foreground">
            Out <span className="font-semibold text-foreground tabular-nums">{outSum.toFixed(2)}</span>
          </span>
          <span className="text-muted-foreground">
            Net{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {(inSum - outSum).toFixed(2)}
            </span>
          </span>
        </>
      );
    },
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
    const ok = await confirmDialog({
      title: "Delete entry?",
      description: "This treasury entry will be permanently removed.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteTreasuryEntry(slug, id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Entry deleted");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Outstanding dues by responsible team member — every unpaid/partial
          order with a holder assigned, not just the ones old enough to count
          as overdue. This is money NOT yet collected from the customer. */}
      {heldCash.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Outstanding dues by team member — {heldCash.reduce((s, h) => s + h.amount, 0).toFixed(2)}{" "}
              across {heldCash.reduce((s, h) => s + h.orderCount, 0)} order(s)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={heldCash}
              rowKey={(h) => h.membershipId}
              empty={{ title: "No outstanding dues" }}
              columns={
                [
                  {
                    key: "holder",
                    header: "Responsible",
                    cardTitle: true,
                    cell: (h) => h.holderName,
                  },
                  { key: "orders", header: "Orders", align: "right", cell: (h) => h.orderCount },
                  {
                    key: "amount",
                    header: "Amount due",
                    align: "right",
                    cell: (h) => <span className="font-medium">{h.amount.toFixed(2)}</span>,
                  },
                ] as Column<HeldCash>[]
              }
            />
          </CardContent>
        </Card>
      )}

      {/* Paid, but the cash isn't confirmed in the treasury yet — either sitting
          with the courier (collected from the customer, not yet remitted) or
          with whichever team member collected it directly. */}
      {withCourier.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-base text-blue-800 dark:text-blue-300">
              Cash with courier (paid, not yet remitted) — {courierTotal.toFixed(2)} across{" "}
              {withCourier.length} order(s)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={withCourier}
              rowKey={(o) => o.orderId}
              colorGroupBy={(o) => o.date}
              colorToggleLabel="Color by date"
              empty={{ title: "Nothing pending from courier" }}
              columns={
                [
                  { key: "date", header: "Date", cell: (o) => o.date },
                  {
                    key: "customer",
                    header: "Customer",
                    cardTitle: true,
                    cell: (o) => o.customerName,
                  },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (o) => <span className="font-medium">{o.amount.toFixed(2)}</span>,
                  },
                  ...(canManage
                    ? [
                        {
                          key: "actions",
                          header: "",
                          cardFullWidth: true,
                          cell: (o: NotDeposited) => (
                            <Button
                              size="sm"
                              onClick={() => onMarkDeposited(o.orderId)}
                              disabled={depositing === o.orderId}
                            >
                              {depositing === o.orderId ? "Saving…" : "Mark remitted"}
                            </Button>
                          ),
                        },
                      ]
                    : []),
                ] as Column<NotDeposited>[]
              }
            />
          </CardContent>
        </Card>
      )}

      {withMembers.length > 0 && (
        <Card className="border-blue-300 dark:border-blue-800">
          <CardHeader>
            <CardTitle className="text-base text-blue-800 dark:text-blue-300">
              Cash with team members (paid, not yet deposited) — {membersTotal.toFixed(2)} across{" "}
              {withMembers.length} order(s)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={withMembers}
              rowKey={(o) => o.orderId}
              colorGroupBy={(o) => o.date}
              colorToggleLabel="Color by date"
              empty={{ title: "Nothing pending deposit" }}
              columns={
                [
                  { key: "date", header: "Date", cell: (o) => o.date },
                  {
                    key: "customer",
                    header: "Customer",
                    cardTitle: true,
                    cell: (o) => o.customerName,
                  },
                  { key: "holder", header: "Held by", cell: (o) => o.heldByName ?? "—" },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (o) => <span className="font-medium">{o.amount.toFixed(2)}</span>,
                  },
                  ...(canManage
                    ? [
                        {
                          key: "actions",
                          header: "",
                          cardFullWidth: true,
                          cell: (o: NotDeposited) => (
                            <Button
                              size="sm"
                              onClick={() => onMarkDeposited(o.orderId)}
                              disabled={depositing === o.orderId}
                            >
                              {depositing === o.orderId ? "Saving…" : "Mark deposited"}
                            </Button>
                          ),
                        },
                      ]
                    : []),
                ] as Column<NotDeposited>[]
              }
            />
          </CardContent>
        </Card>
      )}

      {/* Every unpaid/partial order — rows past 7 days are flagged Overdue,
          so nothing due can hide below the overdue threshold. */}
      {overdue.length > 0 && (
        <Card className="border-amber-300 dark:border-amber-800">
          <CardHeader>
            <CardTitle className="text-base text-amber-800 dark:text-amber-300">
              Payment due — {totalOverdue.toFixed(2)} across {overdue.length} order(s)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTable
              rows={overdue}
              rowKey={(o) => o.orderId}
              colorGroupBy={(o) => o.date}
              colorToggleLabel="Color by date"
              empty={{ title: "No due payments" }}
              columns={
                [
                  { key: "date", header: "Date", sortValue: (o) => o.date, cell: (o) => o.date },
                  {
                    key: "customer",
                    header: "Customer",
                    cardTitle: true,
                    wrap: true,
                    cell: (o) => o.customerName,
                  },
                  { key: "heldBy", header: "Held by", cell: (o) => o.heldByName ?? "—" },
                  {
                    key: "days",
                    header: "Days",
                    align: "right",
                    sortValue: (o) => o.daysOverdue,
                    cell: (o) =>
                      o.daysOverdue >= 7 ? (
                        <span className="font-medium text-amber-700 dark:text-amber-400">
                          {o.daysOverdue} · overdue
                        </span>
                      ) : (
                        o.daysOverdue
                      ),
                  },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    sortValue: (o) => o.amount,
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
                <Select
                  value={partnerId}
                  onValueChange={(v) => setPartnerId(v ?? NONE)}
                  items={[
                    { value: NONE, label: "—" },
                    ...partnerOptions.map((p) => ({ value: p.id, label: p.label })),
                  ]}
                >
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

      {/* Distribute treasury cash to partners by profit share */}
      {canManage && sharePartners.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Distribute to partners</CardTitle>
            <Button size="sm" onClick={() => setDistOpen(true)}>
              Distribute
            </Button>
          </CardHeader>
          {distributions.length > 0 && (
            <CardContent>
              <DataTable
                rows={distributions}
                rowKey={(d) => d.id}
                colorGroupBy={(d) => d.date}
                colorToggleLabel="Color by date"
                empty={{ title: "No distributions yet" }}
                columns={
                  [
                    { key: "date", header: "Date", sortValue: (d) => d.date, cell: (d) => d.date },
                    { key: "note", header: "Note", cardTitle: true, cell: (d) => d.note ?? "—" },
                    {
                      key: "amount",
                      header: "Amount",
                      align: "right",
                      cell: (d) => <span className="font-medium">{d.totalAmount.toFixed(2)}</span>,
                    },
                    {
                      key: "actions",
                      header: "",
                      cardFullWidth: true,
                      cell: (d: Distribution) => (
                        <Button variant="ghost" size="sm" onClick={() => onDeleteDistribution(d.id)}>
                          Delete
                        </Button>
                      ),
                    },
                  ] as Column<Distribution>[]
                }
              />
            </CardContent>
          )}
        </Card>
      )}

      <Dialog open={distOpen} onOpenChange={setDistOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Distribute to partners</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSubmitDistribution} className="space-y-4">
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>
                Treasury balance:{" "}
                <span className="font-medium text-foreground">{balance.toFixed(2)}</span>{" "}
                <span className="text-xs">— the cash actually there</span>
              </p>
              <p>
                Distributable profit:{" "}
                <span
                  className={
                    distributableProfit < 0
                      ? "font-medium text-destructive"
                      : "font-medium text-emerald-600 dark:text-emerald-400"
                  }
                >
                  {distributableProfit.toFixed(2)}
                </span>{" "}
                <span className="text-xs">— what the business actually earned</span>
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="dist-amount">Amount to distribute</Label>
              <Input
                id="dist-amount"
                name="amount"
                type="number"
                step="0.01"
                min="0"
                required
                value={distAmount}
                onChange={(e) => setDistAmount(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dist-date">Date</Label>
              <Input id="dist-date" name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dist-note">Note (optional)</Label>
              <Input id="dist-note" name="note" />
            </div>
            {distAmountNum > 0 && (
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="mb-2 font-medium">
                  Preview{totalPercent !== 100 ? ` (shares normalized to ${totalPercent.toFixed(2)}% → 100%)` : ""}
                </div>
                <div className="space-y-1">
                  {preview.map((p) => (
                    <div key={p.id} className="flex justify-between">
                      <span className="text-muted-foreground">
                        {p.label} ({p.effectivePercent.toFixed(2)}%)
                      </span>
                      <span className="font-medium">{p.amount.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {distAmountNum > balance && (
              <p className="text-sm text-destructive">
                Amount exceeds current treasury balance ({balance.toFixed(2)}).
              </p>
            )}
            {distAmountNum > 0 && distAmountNum <= balance && beyondProfit > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-300">
                  {beyondProfit.toFixed(2)} of this isn&apos;t profit
                </p>
                <p className="mt-1 text-muted-foreground">
                  {distributableProfit <= 0
                    ? "The business hasn't made a distributable profit, so all of this comes out of capital and sales cash — the money the next restock is paid from."
                    : "The rest comes out of capital and sales cash rather than what the business earned."}{" "}
                  You&apos;ll be asked to confirm.
                </p>
              </div>
            )}
            <DialogFooter>
              <Button type="submit" disabled={distLoading || distAmountNum <= 0 || distAmountNum > balance}>
                {distLoading ? "Distributing…" : "Distribute"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Ledger + filters */}
      <div>
        <div className="mb-3 space-y-2">
          <h2 className="text-lg font-semibold">Ledger</h2>
          {bar}
        </div>
        <DataTable
          rows={filtered}
          rowKey={(e) => e.id}
          colorGroupBy={(e) => e.date}
          colorToggleLabel="Color by date"
          searchText={(e) => `${e.source} ${e.partnerName ?? ""} ${e.note ?? ""}`}
          searchPlaceholder="Search source, partner, note…"
          empty={{
            icon: Wallet,
            title: active > 0 ? "No entries match these filters" : "No entries",
          }}
          columns={
            [
              { key: "date", header: "Date", sortValue: (e) => e.date, cell: (e) => e.date },
              {
                key: "dir",
                header: "Dir",
                cell: (e) => (
                  <Badge variant={e.type === "IN" ? "secondary" : "outline"}>{e.type}</Badge>
                ),
              },
              { key: "source", header: "Source", cardTitle: true, cell: (e) => e.source },
              { key: "partner", header: "Partner", hideable: true, cell: (e) => e.partnerName ?? "—" },
              { key: "note", header: "Note", hideable: true, wrap: true, cell: (e) => e.note ?? "—" },
              {
                key: "amount",
                header: "Amount",
                align: "right",
                sortValue: (e) => e.amount,
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
                        ) : e.fromOrder ? (
                          <span className="text-xs text-muted-foreground">from order</span>
                        ) : e.fromPurchase ? (
                          <span className="text-xs text-muted-foreground">from purchase</span>
                        ) : e.fromDistribution ? (
                          <span className="text-xs text-muted-foreground">from distribution</span>
                        ) : e.fromBoost ? (
                          <span className="text-xs text-muted-foreground">from boosting</span>
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
