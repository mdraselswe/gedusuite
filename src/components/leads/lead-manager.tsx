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
  updateLead,
  syncFromWebsite,
  nextManualOrderNo,
  findOrdersForLead,
  linkLeadToOrder,
  unlinkLeadOrder,
  type LinkCandidate,
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
  rowsFromItemsText,
  rowsToItemsText,
  type ItemRow,
} from "@/components/leads/lead-items-editor";
import { splitLeadItems } from "@/lib/lead-items";
import { LeadChannelCell } from "@/components/leads/lead-channel-cell";
import { ORDER_SOURCES, ORDER_SOURCE_LABEL, NO_SOURCE_LABEL } from "@/lib/order-source";
import { toDhakaInputValue } from "@/lib/dhaka-time";
import {
  LEAD_FULFILMENTS,
  LEAD_FULFILMENT_LABEL,
  LEAD_FULFILMENT_TONE,
  type LeadFulfilment,
} from "@/lib/lead-fulfilment";
import { cn } from "@/lib/utils";
import { Money } from "@/components/ui/money";

type Lead = {
  id: string;
  source: string;
  /** Which channel the customer came through; null until somebody tags it. */
  channel: string | null;
  orderNo: string | null;
  wooStatus: string | null;
  date: string;
  /** Dhaka clock time, e.g. "9:30 PM". Separate from `date`, which groups. */
  time: string;
  /** "2026-08-04T21:30" — what the edit form's datetime input needs. */
  orderedAtInput: string;
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
  /** The real order this lead became, once one was entered. */
  orderId: string | null;
  /** Derived from that order — never stored on the lead. */
  fulfilment: LeadFulfilment;
};
type Perms = { canAdd: boolean; canDelete: boolean; canAddCustomer: boolean };

// How the CALL went — where the parcel got to is the Order column, read off
// the linked order. DELIVERED used to sit in this list, which made "called 3
// times" and "arrived" the same kind of fact.
const STATUSES = [
  "NOT_CALLED",
  "NO_ANSWER",
  "PHONE_OFF",
  "WRONG_NUMBER",
  "CALL_LATER",
  "CONFIRMED",
  "CANCELLED",
] as const;

const STATUS_LABEL: Record<string, string> = {
  NOT_CALLED: "Not called",
  NO_ANSWER: "No answer",
  PHONE_OFF: "Phone off",
  WRONG_NUMBER: "Wrong number",
  CALL_LATER: "Call later",
  CONFIRMED: "Confirmed",
  // Named for who did it: the customer said no on the phone. An order
  // cancelled later is the order's own status, in the next column.
  CANCELLED: "Customer said no",
};

// Tints the status trigger so the list is scannable without reading every row.
const STATUS_TONE: Record<string, string> = {
  NOT_CALLED: "border-muted-foreground/30",
  NO_ANSWER: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  PHONE_OFF: "border-orange-500/60 text-orange-700 dark:text-orange-400",
  WRONG_NUMBER: "border-red-500/60 text-red-700 dark:text-red-400",
  CALL_LATER: "border-sky-500/60 text-sky-700 dark:text-sky-400",
  CONFIRMED: "border-emerald-500/60 text-emerald-700 dark:text-emerald-400",
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

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const [itemRows, setItemRows] = useState<ItemRow[]>([newItemRow()]);
  const [total, setTotal] = useState("0");
  // Once the total is typed in by hand, the items stop overwriting it — the
  // person on the phone may have agreed a different figure.
  const [totalTouched, setTotalTouched] = useState(false);
  const [channel, setChannel] = useState<string>(UNTAGGED);
  const [orderedAt, setOrderedAt] = useState("");
  const [orderNo, setOrderNo] = useState("");
  // Whether what's in the box is the app's guess rather than something typed —
  // drives the hint under the field, and nothing else.
  const [orderNoSuggested, setOrderNoSuggested] = useState(false);
  // A number already being typed must not be overwritten when the suggestion
  // comes back, and a suggestion asked for by one open dialog must not land in
  // the next one.
  const orderNoTouched = useRef(false);
  const suggestToken = useRef(0);

  // Only offered when every row is a catalogue product with a price — a
  // half-known total is worse than none.
  const suggestedTotal = itemsTotal(itemRows);
  const effectiveTotal = !totalTouched && suggestedTotal !== null ? String(suggestedTotal) : total;
  // Matching an old lead to an order entered before the two were ever linked.
  const [linkingFor, setLinkingFor] = useState<Lead | null>(null);
  const [linkQuery, setLinkQuery] = useState("");
  const [linkResults, setLinkResults] = useState<LinkCandidate[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
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
    {
      key: "fulfilment",
      label: "Order status",
      kind: "select",
      options: LEAD_FULFILMENTS.map((f) => ({ value: f, label: LEAD_FULFILMENT_LABEL[f] })),
      match: (l, v) => l.fulfilment === v,
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
          <Money value={shown.reduce((s, l) => s + l.total, 0)} />
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

  function openNew() {
    setEditing(null);
    setItemRows([newItemRow()]);
    setTotal("0");
    setTotalTouched(false);
    setChannel(UNTAGGED);
    setOrderedAt(toDhakaInputValue(new Date()));
    // Asked for fresh each time the form opens, so two people adding orders in
    // the same minute don't both work from a number cached at page load.
    setOrderNo("");
    setOrderNoSuggested(false);
    orderNoTouched.current = false;
    const token = ++suggestToken.current;
    nextManualOrderNo(slug).then((res) => {
      if (!res.ok || token !== suggestToken.current || orderNoTouched.current) return;
      setOrderNo(res.orderNo);
      setOrderNoSuggested(true);
    });
    setFormOpen(true);
  }

  function openEdit(l: Lead) {
    setEditing(l);
    // An order that already has a number keeps it — nothing is suggested over
    // the top of it, so a pending request from a previous open is dropped.
    suggestToken.current++;
    setOrderNo(l.orderNo ?? "");
    setOrderNoSuggested(false);
    orderNoTouched.current = true;
    setItemRows(rowsFromItemsText(l.itemsText));
    setTotal(String(l.total));
    // An existing order's total was already agreed; the items must not
    // silently rewrite it just because they were loaded back in.
    setTotalTouched(true);
    setChannel(l.channel ?? UNTAGGED);
    setOrderedAt(l.orderedAtInput);
    setFormOpen(true);
  }

  async function onSubmitLead(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAddSaving(true);
    const fd = new FormData(e.currentTarget);
    // The rows are the form's real state; itemsText is what the server stores.
    fd.set("itemsText", rowsToItemsText(itemRows));
    fd.set("channel", channel === UNTAGGED ? "" : channel);
    const res = editing
      ? await updateLead(slug, editing.id, fd)
      : await createLead(slug, fd);
    setAddSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(editing ? "Order updated" : "Order added");
    setFormOpen(false);
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
    // Creating a customer isn't destructive, but it's a row somebody then has
    // to find and delete — and this button sits in a dense table of dropdowns
    // that get clicked all day, so a slip is easy.
    const ok = await confirmDialog({
      title: "Add this person as a customer?",
      description: `"${lead.customerName}" (${lead.phone}) will be added to the customer list. An existing customer with this number is linked instead of duplicated.`,
      confirmText: "Add customer",
    });
    if (!ok) return;
    setBusyId(lead.id);
    const res = await createCustomerFromLead(slug, lead.id);
    setBusyId(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(
      `"${res.customerName}" added — now search this name on the sales page`,
    );
    router.refresh();
  }

  /**
   * Take a confirmed call through to a real order in one go: make sure the
   * customer exists, then hand the sales page everything it needs to open its
   * order form already filled in. The order it creates links itself back, so
   * the Order column below starts tracking this lead's parcel by itself.
   */
  async function onCreateOrder(lead: Lead) {
    setBusyId(lead.id);
    // Reuses the existing conversion: it matches on phone first, so a repeat
    // buyer doesn't become a second customer row.
    let customerId = lead.convertedCustomerId;
    if (!customerId) {
      const res = await createCustomerFromLead(slug, lead.id);
      if (!res.ok) {
        setBusyId(null);
        return toast.error(res.error);
      }
      customerId = res.customerId ?? null;
    }
    setBusyId(null);
    const params = new URLSearchParams({ fromLead: lead.id });
    if (customerId) params.set("customerId", customerId);
    router.push(`/${slug}/sales/orders?${params}`);
  }

  function openLink(lead: Lead) {
    setLinkingFor(lead);
    setLinkQuery("");
    setLinkResults(null);
    void loadLinkResults(lead, "");
  }

  async function loadLinkResults(lead: Lead, q: string) {
    setLinkBusy(true);
    const res = await findOrdersForLead(slug, lead.id, q);
    setLinkBusy(false);
    if (!res.ok) return toast.error(res.error);
    setLinkResults(res.orders);
  }

  async function onPickOrder(orderId: string) {
    if (!linkingFor) return;
    setLinkBusy(true);
    const res = await linkLeadToOrder(slug, linkingFor.id, orderId);
    setLinkBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Linked — this row now follows that order");
    setLinkingFor(null);
    router.refresh();
  }

  async function onUnlink(lead: Lead) {
    const ok = await confirmDialog({
      title: "Unlink this order?",
      description:
        "The call-list row stops following that order and reads \"Not entered\" again. The order itself is untouched.",
      confirmText: "Unlink",
    });
    if (!ok) return;
    const res = await unlinkLeadOrder(slug, lead.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Unlinked");
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
          <span className="block text-xs font-normal text-muted-foreground">
            {l.date} · {l.time}
          </span>
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
      cell: (l) => <Money value={l.total} />,
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
      key: "fulfilment",
      header: "Order",
      label: "Order",
      sortValue: (l) => l.fulfilment,
      // Read off the linked order, so it can't be edited here — the sales page
      // is where an order's status changes, and one place to change it is the
      // whole point of the split.
      cell: (l) => (
        <span className="inline-flex items-center gap-1.5">
          {/* outline rather than the default variant: the default paints a
              solid primary background the tone would have to fight. */}
          <Badge
            variant="outline"
            className={cn("h-6 px-2 font-normal", LEAD_FULFILMENT_TONE[l.fulfilment])}
          >
            {LEAD_FULFILMENT_LABEL[l.fulfilment]}
          </Badge>
          {l.orderId ? (
            <span className="inline-flex items-center gap-1">
              <a
                href={`/${slug}/sales/orders?q=${encodeURIComponent(l.customerName)}`}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                open
              </a>
              {perms.canAdd && (
                <span aria-hidden className="text-muted-foreground/40">
                  ·
                </span>
              )}
              {perms.canAdd && (
                <button
                  type="button"
                  onClick={() => onUnlink(l)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  title="Stop following this order"
                >
                  unlink
                </button>
              )}
            </span>
          ) : (
            perms.canAdd && (
              <span className="inline-flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs"
                  disabled={busyId === l.id}
                  onClick={() => onCreateOrder(l)}
                  title="Create the real order from this lead — the sales form opens filled in"
                >
                  + Order
                </Button>
                {/* For the backlog: orders entered before the two lists were
                    linked at all. New ones link themselves. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs text-muted-foreground"
                  onClick={() => openLink(l)}
                  title="This order was already entered — point this row at it"
                >
                  link
                </Button>
              </span>
            )
          )}
        </span>
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
          {perms.canAdd && (
            <Button size="sm" variant="ghost" onClick={() => openEdit(l)}>
              Edit
            </Button>
          )}
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
          <Button size="sm" onClick={openNew}>
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
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          {/* Keyed so the uncontrolled fields pick up a different lead's
              defaultValue instead of keeping the last one's. */}
          <form onSubmit={onSubmitLead} key={editing?.id ?? "new"}>
            <DialogHeader>
              <DialogTitle>
                {editing ? "Edit order" : "Add an order to the call list"}
              </DialogTitle>
            </DialogHeader>
            {/* Two columns once there's room for them — the form is filled in
                while someone is on the phone, and pairing the short fields
                keeps the whole thing on screen without scrolling. Each cell
                starts at the top of its row, so the labels line up even when a
                hint makes one side taller. Single column below `sm`, in the
                same order. */}
            <div className="grid items-start gap-x-4 gap-y-3 py-4 sm:grid-cols-2">
              <div className="grid content-start gap-1.5">
                <Label htmlFor="customerName">Customer name</Label>
                <Input
                  id="customerName"
                  name="customerName"
                  required
                  maxLength={120}
                  defaultValue={editing?.customerName ?? ""}
                />
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  name="phone"
                  required
                  maxLength={40}
                  inputMode="tel"
                  defaultValue={editing?.phone ?? ""}
                />
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="orderNo">Order no.</Label>
                <Input
                  id="orderNo"
                  name="orderNo"
                  maxLength={40}
                  placeholder="#0001"
                  value={orderNo}
                  onChange={(e) => {
                    orderNoTouched.current = true;
                    setOrderNoSuggested(false);
                    setOrderNo(e.target.value);
                  }}
                />
                {orderNoSuggested && (
                  <p className="text-xs text-muted-foreground">
                    Next in the series — type your own if this order has one.
                  </p>
                )}
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="orderedAt">Order date &amp; time</Label>
                <Input
                  id="orderedAt"
                  name="orderedAt"
                  type="datetime-local"
                  value={orderedAt}
                  onChange={(e) => setOrderedAt(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Bangladesh time.
                  {editing ? "" : " Defaults to now — change it for an order taken earlier."}
                </p>
              </div>
              <div className="grid content-start gap-1.5">
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
              <div className="grid content-start gap-1.5">
                <Label htmlFor="address">Address</Label>
                <Textarea
                  id="address"
                  name="address"
                  rows={2}
                  maxLength={500}
                  defaultValue={editing?.address ?? ""}
                />
              </div>
              {/* A product search, a quantity and a delete button per row —
                  half a dialog isn't enough for that at any width. */}
              <div className="sm:col-span-2">
                <LeadItemsEditor slug={slug} rows={itemRows} onChange={setItemRows} />
              </div>
              <div className="grid content-start gap-1.5">
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
                    Use <Money value={suggestedTotal} /> from the items
                  </button>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={addSaving}>
                {addSaving ? "Saving…" : editing ? "Save" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Matching the backlog by hand. Orders created from a lead link
          themselves, so this is only for the ones entered before that
          existed — it can go once the old rows are matched up. */}
      <Dialog open={!!linkingFor} onOpenChange={(o) => !o && setLinkingFor(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Which order is this?</DialogTitle>
          </DialogHeader>
          {linkingFor && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {linkingFor.customerName} · {linkingFor.phone} · {linkingFor.itemsText || "no items"}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadLinkResults(linkingFor, linkQuery);
                }}
                className="flex gap-2"
              >
                <Input
                  value={linkQuery}
                  onChange={(e) => setLinkQuery(e.target.value)}
                  placeholder="Search by customer name, phone or tracking ID"
                />
                <Button type="submit" variant="outline" disabled={linkBusy}>
                  Search
                </Button>
              </form>

              {linkResults === null ? (
                <p className="py-6 text-center text-sm text-muted-foreground">Looking…</p>
              ) : linkResults.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  No orders matched. Try the customer&apos;s name, or use + Order to enter it.
                </p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {linkResults.map((o) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        disabled={linkBusy}
                        onClick={() => onPickOrder(o.id)}
                        className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-muted disabled:opacity-60"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {o.customerName}
                            {o.phone && (
                              <span className="font-normal text-muted-foreground"> · {o.phone}</span>
                            )}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {o.date} · {o.status}
                          </span>
                          {o.takenBy && (
                            <span className="block text-xs text-amber-700 dark:text-amber-400">
                              Already linked to {o.takenBy}&apos;s row
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-sm font-medium tabular-nums">
                          <Money value={o.total} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!linkQuery && linkResults && linkResults.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Suggestions: same customer or phone number, plus orders placed within a
                  week of this call. Search above if it isn&apos;t here.
                </p>
              )}
            </div>
          )}
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
