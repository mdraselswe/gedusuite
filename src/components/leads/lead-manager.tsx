"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, PhoneCall, RefreshCw, UserPlus } from "lucide-react";
import {
  createLead,
  setLeadStatus,
  updateLeadNotes,
  createCustomerFromLead,
  deleteLead,
  syncFromWebsite,
} from "@/server/actions/leads";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
} from "@/components/ui/select";
import { DataTable, type Column } from "@/components/ui/data-table";
import { useFilterBar, type FilterDef } from "@/components/ui/filter-bar";
import {
  LeadItemsEditor,
  itemsTotal,
  newItemRow,
  rowsToItemsText,
  type ItemRow,
} from "@/components/leads/lead-items-editor";
import { splitLeadItems } from "@/lib/lead-items";
import { LeadChannelCell } from "@/components/leads/lead-channel-cell";
import { ORDER_SOURCES, ORDER_SOURCE_LABEL, NO_SOURCE_LABEL } from "@/lib/order-source";
import { cn } from "@/lib/utils";

type Lead = {
  id: string;
  source: string;
  /** Which channel the customer came through; null until somebody tags it. */
  channel: string | null;
  orderNo: string | null;
  wooStatus: string | null;
  date: string;
  customerName: string;
  phone: string;
  altPhone: string | null;
  address: string | null;
  itemsText: string;
  total: number;
  callStatus: string;
  callAttempts: number;
  calledByName: string | null;
  customerAdvice: string | null;
  internalNote: string | null;
  convertedCustomerId: string | null;
};
type Perms = { canAdd: boolean; canDelete: boolean; canAddCustomer: boolean };

const STATUSES = [
  "NOT_CALLED",
  "NO_ANSWER",
  "PHONE_OFF",
  "WRONG_NUMBER",
  "CALL_LATER",
  "CONFIRMED",
  "DELIVERED",
  "CANCELLED",
] as const;

const STATUS_LABEL: Record<string, string> = {
  NOT_CALLED: "Not called",
  NO_ANSWER: "No answer",
  PHONE_OFF: "Phone off",
  WRONG_NUMBER: "Wrong number",
  CALL_LATER: "Call later",
  CONFIRMED: "Confirmed",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

// Tints the status trigger so the list is scannable without reading every row.
const STATUS_TONE: Record<string, string> = {
  NOT_CALLED: "border-muted-foreground/30",
  NO_ANSWER: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  PHONE_OFF: "border-orange-500/60 text-orange-700 dark:text-orange-400",
  WRONG_NUMBER: "border-red-500/60 text-red-700 dark:text-red-400",
  CALL_LATER: "border-sky-500/60 text-sky-700 dark:text-sky-400",
  CONFIRMED: "border-emerald-500/60 text-emerald-700 dark:text-emerald-400",
  // Same happy path as Confirmed but the end of it — filled rather than a
  // second emerald outline, so the two aren't a coin-flip at a glance.
  DELIVERED:
    "border-emerald-600/70 bg-emerald-500/10 font-semibold text-emerald-700 dark:text-emerald-300",
  CANCELLED: "border-muted-foreground/40 text-muted-foreground line-through",
};

/** Sentinel for the "abandoned checkout" option, which is a wooStatus rather
 *  than a source — the two live in one dropdown because "where did this come
 *  from" is one question to the person making the calls. */
const DRAFT = "__draft__";
/** Leads nobody has tagged yet — a real answer, not the absence of one. */
const UNTAGGED = "__untagged__";

/** One-tap copy, so a detail can be pasted straight into the order form. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
      className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          toast.error("Couldn't copy — your browser blocked clipboard access");
        }
      }}
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function LeadManager({
  slug,
  leads,
  perms,
}: {
  slug: string;
  leads: Lead[];
  perms: Perms;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const [itemRows, setItemRows] = useState<ItemRow[]>([newItemRow()]);
  const [total, setTotal] = useState("0");
  // Once the total is typed in by hand, the items stop overwriting it — the
  // person on the phone may have agreed a different figure.
  const [totalTouched, setTotalTouched] = useState(false);
  const [channel, setChannel] = useState<string>(UNTAGGED);

  // Only offered when every row is a catalogue product with a price — a
  // half-known total is worse than none.
  const suggestedTotal = itemsTotal(itemRows);
  const effectiveTotal = !totalTouched && suggestedTotal !== null ? String(suggestedTotal) : total;
  const [notesFor, setNotesFor] = useState<Lead | null>(null);
  const [notesSaving, setNotesSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Pull from the website once the list is on screen, not while rendering it:
  // WooCommerce fires no webhook for abandoned checkouts, so they'd otherwise
  // never appear. The page paints from the database first and picks up
  // anything new a moment later; the action throttles itself server-side, so
  // opening the list repeatedly doesn't hammer the store.
  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current) return;
    autoSynced.current = true;
    syncFromWebsite(slug).then((res) => {
      if (res.ok && !res.skipped && res.imported) router.refresh();
    });
  }, [slug, router]);

  async function onRefresh() {
    setSyncing(true);
    const res = await syncFromWebsite(slug, true);
    setSyncing(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(res.imported ? `Checked the website — ${res.imported} orders` : "Up to date");
    router.refresh();
  }

  const filters: FilterDef<Lead>[] = [
    {
      key: "status",
      label: "All statuses",
      kind: "select",
      primary: true,
      options: STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
      match: (l, v) => l.callStatus === v,
    },
    {
      key: "channel",
      label: "Where it came from",
      kind: "select",
      options: [
        ...ORDER_SOURCES.map((c) => ({ value: c, label: ORDER_SOURCE_LABEL[c] })),
        { value: UNTAGGED, label: NO_SOURCE_LABEL },
        // An abandoned checkout is a different conversation from a placed
        // order, so it's worth being able to call just those. It's a
        // WooCommerce state rather than a channel, but "where did this come
        // from" is one question to the person making the calls.
        { value: DRAFT, label: "Abandoned checkout" },
      ],
      match: (l, v) => {
        if (v === DRAFT) return l.wooStatus === "checkout-draft";
        if (v === UNTAGGED) return !l.channel;
        return l.channel === v;
      },
    },
    {
      key: "customer",
      label: "Customer record",
      kind: "select",
      options: [
        { value: "yes", label: "Already added" },
        { value: "no", label: "Not added yet" },
      ],
      match: (l, v) => (v === "yes" ? !!l.convertedCustomerId : !l.convertedCustomerId),
    },
    { key: "date", label: "Order date", kind: "dateRange", value: (l) => l.date },
    { key: "total", label: "Order total", kind: "numberRange", value: (l) => l.total },
    {
      key: "tries",
      label: "Call attempts",
      kind: "numberRange",
      step: "1",
      value: (l) => l.callAttempts,
    },
  ];

  const { rows: filtered, bar, active } = useFilterBar(leads, filters, {
    summary: (shown) => (
      <span className="text-muted-foreground">
        Total{" "}
        <span className="font-semibold text-foreground tabular-nums">
          {shown.reduce((s, l) => s + l.total, 0).toFixed(2)}
        </span>
      </span>
    ),
  });

  async function onStatusChange(lead: Lead, next: string) {
    setBusyId(lead.id);
    const res = await setLeadStatus(slug, lead.id, next);
    setBusyId(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Marked "${STATUS_LABEL[next]}"`);
    router.refresh();
  }

  async function onAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAddSaving(true);
    const fd = new FormData(e.currentTarget);
    // The rows are the form's real state; itemsText is what the server stores.
    fd.set("itemsText", rowsToItemsText(itemRows));
    fd.set("channel", channel === UNTAGGED ? "" : channel);
    const res = await createLead(slug, fd);
    setAddSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Order added");
    setAddOpen(false);
    setItemRows([newItemRow()]);
    setTotal("0");
    setTotalTouched(false);
    setChannel(UNTAGGED);
    router.refresh();
  }

  async function onSaveNotes(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!notesFor) return;
    setNotesSaving(true);
    const res = await updateLeadNotes(slug, notesFor.id, new FormData(e.currentTarget));
    setNotesSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Saved");
    setNotesFor(null);
    router.refresh();
  }

  async function onCreateCustomer(lead: Lead) {
    setBusyId(lead.id);
    const res = await createCustomerFromLead(slug, lead.id);
    setBusyId(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(
      `"${res.customerName}" added — now search this name on the sales page`,
    );
    router.refresh();
  }

  async function onDelete(lead: Lead) {
    const ok = await confirmDialog({
      title: "Delete this entry?",
      description: `"${lead.customerName}" will be removed from the call list. No order or customer is affected.`,
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteLead(slug, lead.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Deleted");
    router.refresh();
  }

  const columns: Column<Lead>[] = [
    {
      key: "order",
      header: "Order",
      sortValue: (l) => l.date,
      cell: (l) => (
        <span>
          <span className="inline-flex items-center gap-1.5">
            {l.orderNo ?? "—"}
            {/* An abandoned checkout, not a placed order — the call is "do you
                want to finish it?", not "confirming your order". Amber rather
                than red: it needs noticing, but it's an opportunity, not a
                failure. Stronger than the section palette's /10 tint because
                this one has to carry across a dense table at a glance. */}
            {l.wooStatus === "checkout-draft" && (
              <Badge
                className="border-amber-500/40 bg-amber-500/20 font-semibold text-amber-700 dark:bg-amber-500/25 dark:text-amber-300"
                title="Customer filled the checkout form but never placed the order"
              >
                Draft
              </Badge>
            )}
          </span>
          <span className="block text-xs font-normal text-muted-foreground">{l.date}</span>
        </span>
      ),
    },
    {
      key: "channel",
      header: "Channel",
      hideable: true,
      sortValue: (l) => l.channel ?? "",
      cell: (l) => (
        <LeadChannelCell
          slug={slug}
          leadId={l.id}
          value={l.channel}
          canEdit={perms.canAdd}
        />
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cardTitle: true,
      wrap: true,
      sortValue: (l) => l.customerName.toLowerCase(),
      cell: (l) => (
        <span>
          <span className="inline-flex items-center gap-1">
            {l.customerName}
            <CopyButton value={l.customerName} label="name" />
          </span>
          {l.address && (
            <span className="flex items-start gap-1 text-xs font-normal text-muted-foreground">
              <span className="max-w-60 whitespace-normal">{l.address}</span>
              <CopyButton value={l.address} label="address" />
            </span>
          )}
        </span>
      ),
    },
    {
      key: "phone",
      header: "Phone",
      cell: (l) => (
        <span className="inline-flex items-center gap-1">
          {/* tel: makes this one tap to dial from the installed PWA on a phone. */}
          <a href={`tel:${l.phone}`} className="font-medium tabular-nums hover:underline">
            {l.phone}
          </a>
          <CopyButton value={l.phone} label="phone" />
        </span>
      ),
    },
    {
      key: "items",
      header: "Items",
      wrap: true,
      // One line per item: a website order with five products in a single
      // run-on string is unreadable at a glance.
      cell: (l) => {
        const items = splitLeadItems(l.itemsText);
        if (items.length === 0) return <span className="text-sm">—</span>;
        return (
          <span className="block max-w-72 space-y-0.5 text-sm">
            {items.map((it, i) => (
              <span key={i} className="block whitespace-normal">
                {it}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: "total",
      header: "Total",
      align: "right",
      sortValue: (l) => l.total,
      cell: (l) => l.total.toFixed(2),
    },
    {
      key: "status",
      header: "Call status",
      label: "Call status",
      sortValue: (l) => l.callStatus,
      cell: (l) => (
        <Select
          value={l.callStatus}
          onValueChange={(v) => v && onStatusChange(l, v)}
          disabled={!perms.canAdd || busyId === l.id}
        >
          {/* Base UI's <SelectValue/> prints the raw value until the popup has
              mounted its items, so the label is rendered directly instead. */}
          <SelectTrigger className={cn("h-8 w-38", STATUS_TONE[l.callStatus])}>
            <span data-slot="select-value">{STATUS_LABEL[l.callStatus]}</span>
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      key: "attempts",
      header: "Tries",
      align: "right",
      hideable: true,
      sortValue: (l) => l.callAttempts,
      cell: (l) => (
        <span title={l.calledByName ? `Last by ${l.calledByName}` : undefined}>
          {l.callAttempts || "—"}
        </span>
      ),
    },
    {
      key: "advice",
      header: "Customer said",
      wrap: true,
      hideable: true,
      cell: (l) => (
        <button
          type="button"
          onClick={() => setNotesFor(l)}
          disabled={!perms.canAdd}
          className="max-w-64 text-left text-sm whitespace-normal hover:underline disabled:hover:no-underline"
        >
          {l.customerAdvice ?? <span className="text-muted-foreground">+ Add note</span>}
        </button>
      ),
    },
    {
      key: "actions",
      header: "",
      cardFullWidth: true,
      cell: (l) => (
        <div className="flex items-center justify-end gap-1">
          {perms.canAddCustomer &&
            (l.convertedCustomerId ? (
              <span className="text-xs text-muted-foreground">Customer added</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === l.id}
                onClick={() => onCreateCustomer(l)}
                title="Create this person as a customer, then pick them on the sales page"
              >
                <UserPlus data-icon="inline-start" />
                Customer
              </Button>
            ))}
          {perms.canDelete && (
            <Button size="sm" variant="ghost" onClick={() => onDelete(l)}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">{bar}</div>
        {perms.canAdd && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            + Add order
          </Button>
        )}
        {perms.canAdd && (
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={syncing}>
            <RefreshCw data-icon="inline-start" className={cn(syncing && "animate-spin")} />
            {syncing ? "Checking…" : "Refresh"}
          </Button>
        )}
      </div>

      <DataTable
        rows={filtered}
        rowKey={(l) => l.id}
        colorGroupBy={(l) => l.date}
        colorToggleLabel="Color by date"
        searchText={(l) =>
          `${l.customerName} ${l.phone} ${l.orderNo ?? ""} ${l.itemsText} ${l.address ?? ""}`
        }
        searchPlaceholder="Search name, phone, order…"
        empty={{
          icon: PhoneCall,
          title:
            active > 0 ? "No orders match these filters" : "No online orders yet",
        }}
        columns={columns}
      />

      {/* Manual entry — lets the list be used before the website is wired up. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <form onSubmit={onAdd}>
            <DialogHeader>
              <DialogTitle>Add an order to the call list</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              <div className="grid gap-1.5">
                <Label htmlFor="customerName">Customer name</Label>
                <Input id="customerName" name="customerName" required maxLength={120} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" name="phone" required maxLength={40} inputMode="tel" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="orderNo">Order no.</Label>
                  <Input id="orderNo" name="orderNo" maxLength={40} placeholder="#1284" />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lead-channel">Where from</Label>
                <Select
                  value={channel}
                  onValueChange={(v) => setChannel(v ?? UNTAGGED)}
                  items={[
                    { value: UNTAGGED, label: NO_SOURCE_LABEL },
                    ...ORDER_SOURCES.map((c) => ({ value: c, label: ORDER_SOURCE_LABEL[c] })),
                  ]}
                >
                  <SelectTrigger id="lead-channel" className="w-full">
                    <span data-slot="select-value">
                      {channel === UNTAGGED ? NO_SOURCE_LABEL : ORDER_SOURCE_LABEL[channel]}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNTAGGED}>{NO_SOURCE_LABEL}</SelectItem>
                    {ORDER_SOURCES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {ORDER_SOURCE_LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="address">Address</Label>
                <Textarea id="address" name="address" rows={2} maxLength={500} />
              </div>
              <LeadItemsEditor slug={slug} rows={itemRows} onChange={setItemRows} />
              <div className="grid gap-1.5">
                <Label htmlFor="total">Total</Label>
                <Input
                  id="total"
                  name="total"
                  type="number"
                  step="0.01"
                  min="0"
                  value={effectiveTotal}
                  onChange={(e) => {
                    setTotalTouched(true);
                    setTotal(e.target.value);
                  }}
                />
                {suggestedTotal !== null && Number(effectiveTotal) !== suggestedTotal && (
                  <button
                    type="button"
                    className="justify-self-start text-xs text-muted-foreground underline"
                    onClick={() => {
                      setTotalTouched(true);
                      setTotal(String(suggestedTotal));
                    }}
                  >
                    Use {suggestedTotal.toFixed(2)} from the items
                  </button>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={addSaving}>
                {addSaving ? "Saving…" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!notesFor} onOpenChange={(o) => !o && setNotesFor(null)}>
        <DialogContent>
          <form onSubmit={onSaveNotes}>
            <DialogHeader>
              <DialogTitle>{notesFor?.customerName}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              <div className="grid gap-1.5">
                <Label htmlFor="customerAdvice">What the customer said</Label>
                <Textarea
                  id="customerAdvice"
                  name="customerAdvice"
                  rows={3}
                  maxLength={1000}
                  defaultValue={notesFor?.customerAdvice ?? ""}
                  placeholder="e.g. send after Eid, call before delivery"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="internalNote">Internal note</Label>
                <Textarea
                  id="internalNote"
                  name="internalNote"
                  rows={2}
                  maxLength={1000}
                  defaultValue={notesFor?.internalNote ?? ""}
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={notesSaving}>
                {notesSaving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
