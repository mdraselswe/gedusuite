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
import { beyondDistributableProfit, splitByShare } from "@/lib/profit-share";
import { Money } from "@/components/ui/money";
import { Field, FormError, type FieldError } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";
import { formatMoney } from "@/lib/money";
import { InfoNote } from "@/components/ui/info-note";
import { toneForBalance } from "@/lib/money";
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
  /** What the treasury will receive — the courier's cut already taken off. */
  amount: number;
  /** What the customer paid. */
  gross: number;
  /** Delivery cost + COD fee the courier keeps before remitting. */
  courierCharges: number;
  paymentMethod: string;
  heldByName: string | null;
  isCourierCollection: boolean;
  /** A refused parcel that collected the shipping anyway — not a sale. */
  cancelled: boolean;
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
  netProfit,
  alreadyDistributed,
  supplierDues,
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
  /** What is LEFT to hand out — earnings less everything already distributed. */
  distributableProfit: number;
  /** Lifetime earnings, shown so the remaining figure can be explained. */
  netProfit: number;
  /** Total of every distribution made so far. */
  alreadyDistributed: number;
  /** What is owed for goods bought on credit, by supplier. */
  supplierDues: { supplierId: string | null; supplierName: string; amount: number; rows: number }[];
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
  const beyondProfit = beyondDistributableProfit(distributableProfit, distAmountNum);

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
  const courierGross = withCourier.reduce((s, o) => s + o.gross, 0);
  const courierCharges = withCourier.reduce((s, o) => s + o.courierCharges, 0);
  const membersTotal = withMembers.reduce((s, o) => s + o.amount, 0);
  const owedToSuppliers = supplierDues.reduce((s, r) => s + r.amount, 0);

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
  const [amount, setAmount] = useState("");
  // The whole failure, kept so the field it names can turn red. A toast alone
  // left "Amount must be > 0" hovering over a form with six inputs.
  const [formError, setFormError] = useState<FieldError>(null);
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
            In <span className="font-semibold text-foreground tabular-nums"><Money value={inSum} /></span>
          </span>
          <span className="text-muted-foreground">
            Out <span className="font-semibold text-foreground tabular-nums"><Money value={outSum} /></span>
          </span>
          <span className="text-muted-foreground">
            Net{" "}
            <span className="font-semibold text-foreground tabular-nums">
              <Money value={(inSum - outSum)} />
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
              Outstanding dues by team member — <Money value={heldCash.reduce((s, h) => s + h.amount, 0)} />{" "}
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
                    cell: (h) => <span className="font-medium"><Money value={h.amount} /></span>,
                  },
                ] as Column<HeldCash>[]
              }
            />
          </CardContent>
        </Card>
      )}

      {/* The other direction: money in the treasury that is already spoken for.
          Goods bought on terms are a bill that arrives whether or not anyone
          remembered it when they last looked at the balance. */}
      {supplierDues.length > 0 && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="text-base text-amber-800 dark:text-amber-300">
              Owed to suppliers — <Money value={owedToSuppliers} />
            </CardTitle>
            {/* The one thing that must be read stays visible; the how-to folds
                away. Before this both were one paragraph and neither got read. */}
            {owedToSuppliers > balance ? (
              <InfoNote
                tone="warn"
                title={
                  <>
                    The treasury balance (<Money value={balance} />) doesn&apos;t cover
                    this
                  </>
                }
              >
                <p>
                  Settle a bill by editing the purchase and changing its funding to
                  Treasury or a partner — that writes the payment and clears it from
                  here.
                </p>
              </InfoNote>
            ) : (
              <InfoNote title="How to settle one of these">
                <p>
                  Edit the purchase and change its funding from Credit to Treasury or a
                  partner. That writes the payment exactly as it would have been at the
                  time, and the row drops off this list.
                </p>
              </InfoNote>
            )}
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {supplierDues.map((r) => (
                <div key={r.supplierId ?? "__none__"} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {r.supplierName}{" "}
                    <span className="text-xs">
                      ({r.rows} item{r.rows === 1 ? "" : "s"})
                    </span>
                  </span>
                  <span className="font-medium tabular-nums"><Money value={r.amount} /></span>
                </div>
              ))}
            </div>
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
              Cash with courier (paid, not yet remitted) — <Money value={courierTotal} /> across{" "}
              {withCourier.length} order(s)
            </CardTitle>
            {courierCharges > 0 && (
              <InfoNote
                title={
                  <>
                    Customers paid <Money value={courierGross} />; the courier keeps{" "}
                    <Money value={courierCharges} />
                  </>
                }
              >
                <p>
                  A courier doesn&apos;t hand over what it collected — it hands over what
                  is left after its delivery charge and its percentage fee. The figures
                  above are what will actually reach the treasury, which is why they read
                  lower than the invoices.
                </p>
              </InfoNote>
            )}
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
                    // A cancelled row is here because the courier really is
                    // holding the shipping a refused parcel collected — but it
                    // is not a sale, and an unmarked row reads like one.
                    cell: (o) => (
                      <span className="inline-flex items-center gap-2">
                        {o.customerName}
                        {o.cancelled && (
                          <span
                            className="rounded bg-orange-500/10 px-1.5 py-0.5 text-xs text-orange-700 dark:text-orange-300"
                            title="Cancelled order — the customer paid the delivery and sent the goods back"
                          >
                            partial
                          </span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (o) => <span className="font-medium"><Money value={o.amount} /></span>,
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
              Cash with team members (paid, not yet deposited) — <Money value={membersTotal} /> across{" "}
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
                    cell: (o) => <span className="font-medium"><Money value={o.amount} /></span>,
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
              Payment due — <Money value={totalOverdue} /> across {overdue.length} order(s)
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
                      <span className="font-medium text-destructive"><Money value={o.amount} /></span>
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
              <Field name="amount" label="Amount" error={formError} required>
                <MoneyInput
                  min="0"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field name="date" label="Date" error={formError} required>
                <Input type="date" required />
              </Field>
              <Field name="source" label="Source" error={formError} hint="What this money was for" required>
                <Input required placeholder="Sales, Rent, …" />
              </Field>
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
              <Field name="note" label="Note" error={formError}>
                <Input />
              </Field>
              <div className="space-y-3 sm:col-span-3">
                <FormError error={formError} />
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
                      cell: (d) => <span className="font-medium"><Money value={d.totalAmount} /></span>,
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
                <span className="font-medium text-foreground"><Money value={balance} /></span>{" "}
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
                  <Money value={distributableProfit} />
                </span>{" "}
                <span className="text-xs">— what is still left to hand out</span>
              </p>
              {/* Spelled out, because "distributable profit" going down after a
                  payout is otherwise indistinguishable from the business having
                  had a bad month. */}
              {alreadyDistributed > 0 && (
                <p className="text-xs">
                  Earned <Money value={netProfit} /> in total, <Money value={alreadyDistributed} />{" "}
                  already distributed.
                </p>
              )}
            </div>
            <Field
              name="amount"
              label="Amount to distribute"
              hint={`At most ${formatMoney(balance)} — the cash actually in the treasury`}
              required
            >
              <MoneyInput
                min="0"
                required
                value={distAmount}
                onChange={(e) => setDistAmount(e.target.value)}
              />
            </Field>
            <Field name="date" label="Date" required>
              <Input type="date" required defaultValue={new Date().toISOString().slice(0, 10)} />
            </Field>
            <Field name="note" label="Note (optional)">
              <Input id="dist-note" name="note" />
            </Field>
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
                      <span className="font-medium"><Money value={p.amount} /></span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {distAmountNum > balance && (
              <p className="text-sm text-destructive">
                Amount exceeds current treasury balance (<Money value={balance} />).
              </p>
            )}
            {/* A treasury that can't cover the supplier bill after this payout
                is the same failure as distributing capital, one creditor along
                — and this one has a date on it. */}
            {distAmountNum > 0 &&
              distAmountNum <= balance &&
              owedToSuppliers > 0 &&
              balance - distAmountNum < owedToSuppliers && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <p className="font-medium text-amber-800 dark:text-amber-300">
                    <Money value={owedToSuppliers} /> is owed to suppliers
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    This leaves <Money value={(balance - distAmountNum)} /> in the treasury,
                    which doesn&apos;t cover it. You&apos;ll be asked to confirm.
                  </p>
                </div>
              )}
            {distAmountNum > 0 && distAmountNum <= balance && beyondProfit > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p className="font-medium text-amber-800 dark:text-amber-300">
                  <Money value={beyondProfit} /> of this isn&apos;t profit
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
                    <Money value={e.amount} />
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
