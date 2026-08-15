"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import {
  Check,
  Copy,
  MoreVertical,
  PhoneCall,
  RefreshCw,
  Repeat2,
  UserCheck,
  X,
} from "lucide-react";
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
import { searchCustomers } from "@/server/actions/search";
import { customerContact } from "@/server/actions/customers";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { AsyncCombobox, type ComboOption } from "@/components/ui/async-combobox";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { leadBreakdown, suggestedLeadTotal } from "@/lib/lead-total";
import { LeadChannelCell } from "@/components/leads/lead-channel-cell";
import { ORDER_SOURCES, ORDER_SOURCE_LABEL, NO_SOURCE_LABEL } from "@/lib/order-source";
import { toDhakaInputValue } from "@/lib/dhaka-time";
import {
  LEAD_FULFILMENTS,
  LEAD_FULFILMENT_LABEL,
  LEAD_FULFILMENT_ROW_TONE,
  LEAD_FULFILMENT_TONE,
  type LeadFulfilment,
} from "@/lib/lead-fulfilment";
import type { BuyerHistory } from "@/lib/buyer-history";
import { cn } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { Stamp } from "@/components/ui/stamp";
import type { DhakaStamp } from "@/lib/dhaka-time";

type Lead = DhakaStamp & {
  id: string;
  source: string;
  /** Which channel the customer came through; null until somebody tags it. */
  channel: string | null;
  orderNo: string | null;
  wooStatus: string | null;
  customerName: string;
  phone: string;
  altPhone: string | null;
  address: string | null;
  itemsText: string;
  /** Agreed shipping, kept apart from the goods. */
  deliveryCharge: number;
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
  /** What this phone number ordered before. null when it's a first-time buyer. */
  history: BuyerHistory | null;
};
type Perms = {
  canAdd: boolean;
  canDelete: boolean;
  canAddCustomer: boolean;
  canViewCustomers: boolean;
};

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
  // Was muted grey and struck through — the look of a row already dealt with.
  // It is the one the caller most needs to see: somebody rang, and the answer
  // was no. Filled in the same red the order side uses for a cancellation, so
  // "this one is lost" reads the same way in both columns.
  CANCELLED:
    "border-red-500/60 bg-red-500/10 font-medium text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * A tint for the whole row when the CALL ended in a no.
 *
 * Separate from the fulfilment tone below it: this is the customer refusing on
 * the phone, before any order exists, and it is far more common than an order
 * that was entered and then cancelled. One tinted select in one column is
 * still easy to skim past in a table this wide.
 */
const CALL_ROW_TONE: Record<string, string | undefined> = {
  CANCELLED: "border-l-red-500 bg-red-500/5 dark:bg-red-500/10",
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
  query,
  totalCount,
}: {
  slug: string;
  leads: Lead[];
  perms: Perms;
  /** The search the server ran, so the box survives the refresh it triggers. */
  query: string;
  /** Leads in the whole call list, not just this page — for "showing N of M". */
  totalCount: number;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [addSaving, setAddSaving] = useState(false);
  const [itemRows, setItemRows] = useState<ItemRow[]>([newItemRow()]);
  const [total, setTotal] = useState("0");
  const [delivery, setDelivery] = useState("0");
  // Once the total is typed in by hand, the items stop overwriting it — the
  // person on the phone may have agreed a different figure.
  const [totalTouched, setTotalTouched] = useState(false);
  const [channel, setChannel] = useState<string>(UNTAGGED);
  // The customer book, searchable from the form. Most rows are still a name
  // typed off the phone, but a repeat buyer was previously retyped from
  // scratch every time — three fields the app already knew, and a lead that
  // ended up unlinked from the record holding their order history.
  const [customer, setCustomer] = useState<ComboOption | null>(null);
  // Contact details are prefilled from a pick, so they can't stay uncontrolled.
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  // Same guard as the order-number suggestion: a slow lookup started by one
  // open dialog must not drop its answer into the next one.
  const customerToken = useRef(0);
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
  // The goods on their own, and what the customer actually pays. Keeping the
  // two apart is the point: the items add up to one number and the caller
  // quotes another, and before this there was nothing to say whether the
  // difference was shipping or a discount — the only way to get delivery into
  // the figure was to overwrite the total by hand and lose the breakdown.
  const goodsTotal = itemsTotal(itemRows);
  const deliveryAmount = Math.max(0, Number(delivery) || 0);
  const suggestedTotal = suggestedLeadTotal(goodsTotal, deliveryAmount);
  const effectiveTotal = !totalTouched && suggestedTotal !== null ? String(suggestedTotal) : total;
  const breakdown = leadBreakdown(goodsTotal, deliveryAmount, Number(effectiveTotal) || 0);
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
    total: totalCount,
  });

  // ── Search: URL-driven, so the server queries every page ──
  // The filters above stay in memory — they narrow a list somebody is reading.
  // A number is the opposite: it's asked when the phone rings and the lead may
  // be pages back, so it has to be a query rather than a filter over the rows
  // that happen to be on screen.
  const [search, setSearch] = useState(query);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function pushSearch(v: string) {
    const params = new URLSearchParams();
    const qv = v.trim();
    if (qv) params.set("q", qv);
    // No page param: a new search starts at the first page of its own results.
    router.replace(`/${slug}/leads${params.size ? `?${params}` : ""}`);
  }
  function onSearchChange(v: string) {
    setSearch(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => pushSearch(v), 400);
  }
  useEffect(() => {
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, []);

  async function onStatusChange(lead: Lead, next: string) {
    setBusyId(lead.id);
    const res = await setLeadStatus(slug, lead.id, next);
    setBusyId(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Marked "${STATUS_LABEL[next]}"`);
    router.refresh();
  }

  /** Fill the contact fields from a picked customer — or clear the pick. */
  async function onPickCustomer(opt: ComboOption | null) {
    setCustomer(opt);
    if (!opt) return;
    const token = ++customerToken.current;
    const c = await customerContact(slug, opt.value);
    if (!c || token !== customerToken.current) return;
    // Overwritten rather than merged: picking a different person and keeping
    // the last one's address is how a parcel goes to the wrong house.
    setCustomerName(c.name);
    setPhone(c.phone ?? "");
    setAddress(c.address ?? "");
  }

  function openNew() {
    setEditing(null);
    customerToken.current++;
    setCustomer(null);
    setCustomerName("");
    setPhone("");
    setAddress("");
    setItemRows([newItemRow()]);
    setTotal("0");
    setDelivery("0");
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
    setCustomerName(l.customerName);
    setPhone(l.phone);
    setAddress(l.address ?? "");
    // The row knows the id it was linked to but not that customer's name, so
    // the box would otherwise open blank on a lead that is already linked —
    // and look like nothing was picked. Fetched rather than carried on every
    // row: it's one label, needed only once the dialog is open.
    const linkedId = l.convertedCustomerId;
    const token = ++customerToken.current;
    setCustomer(null);
    if (linkedId) {
      customerContact(slug, linkedId).then((c) => {
        if (!c || token !== customerToken.current) return;
        // Same shape as the search results, so the picked row and the list
        // below it read alike.
        setCustomer({ value: linkedId, label: c.phone ? `${c.name} · ${c.phone}` : c.name });
      });
    }
    setItemRows(rowsFromItemsText(l.itemsText));
    setTotal(String(l.total));
    setDelivery(String(l.deliveryCharge));
    // An existing order's total was already agreed; the items must not
    // silently rewrite it just because they were loaded back in.
    setTotalTouched(true);
    setChannel(l.channel ?? UNTAGGED);
    setOrderedAt(l.dateInput);
    setFormOpen(true);
  }

  async function onSubmitLead(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAddSaving(true);
    const fd = new FormData(e.currentTarget);
    // The rows are the form's real state; itemsText is what the server stores.
    fd.set("itemsText", rowsToItemsText(itemRows));
    fd.set("channel", channel === UNTAGGED ? "" : channel);
    fd.set("customerId", customer?.value ?? "");
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
    // `matched` means nothing was created — this number already had a customer
    // and the lead was linked to it. Saying "added" there is wrong twice over:
    // no row was added, and res.customerName is the EXISTING record's name, so
    // a lead for "Rajib" could report "Rajib Hasan added" with no explanation.
    toast.success(
      res.matched
        ? `Linked to "${res.customerName}" — this number already ordered before`
        : `"${res.customerName}" added — now search this name on the sales page`,
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
            <Stamp date={l.date} time={l.time} entered={l.entered} />
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
      // Name, number and address are one block rather than three columns: they
      // are read together — the caller looks at the row, dials, and reads the
      // address back — and as separate columns they were most of the width
      // that pushed this table off the side of the screen.
      key: "customer",
      header: "Customer",
      cardTitle: true,
      wrap: true,
      sortValue: (l) => l.customerName.toLowerCase(),
      cell: (l) => (
        <span className="block max-w-56 space-y-0.5">
          <span className="flex flex-wrap items-center gap-1">
            <span className="whitespace-normal">{l.customerName}</span>
            <CopyButton value={l.customerName} label="name" />
            <RepeatBadge history={l.history} />
            {/* Was a "Customer added" line in the actions column. It's a fact
                about this person, so it sits with their name — and it costs a
                badge here instead of a column's worth of width there. */}
            {l.convertedCustomerId && (
              <span title="Already in the customer list" className="inline-flex">
                <UserCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 text-xs font-normal">
            {/* tel: makes this one tap to dial from the installed PWA on a phone. */}
            <a href={`tel:${l.phone}`} className="font-medium tabular-nums hover:underline">
              {l.phone}
            </a>
            <CopyButton value={l.phone} label="phone" />
          </span>
          {l.address && (
            <span className="flex items-start gap-1 text-xs font-normal text-muted-foreground">
              <span className="whitespace-normal">{l.address}</span>
              <CopyButton value={l.address} label="address" />
            </span>
          )}
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
          <span className="block max-w-56 space-y-0.5 text-sm">
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
      // The grand total, with the shipping inside it named underneath — the
      // caller quotes the one figure, and the packer needs to know how much of
      // it isn't goods.
      cell: (l) => (
        <span className="block">
          <Money value={l.total} />
          {l.deliveryCharge > 0 && (
            <span className="block text-xs text-muted-foreground">
              incl. <Money value={l.deliveryCharge} /> delivery
            </span>
          )}
        </span>
      ),
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
          <SelectTrigger className={cn("h-8 w-36", STATUS_TONE[l.callStatus])}>
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
          {/* Only the one action this column is for. Linking and unlinking are
              rare — a backlog job and an undo — so they moved to the row menu
              rather than each costing width on every row. */}
          {l.orderId ? (
            <a
              href={`/${slug}/sales/orders?q=${encodeURIComponent(l.customerName)}`}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              open
            </a>
          ) : (
            perms.canAdd && (
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
          className="max-w-48 text-left text-sm whitespace-normal hover:underline disabled:hover:no-underline"
        >
          {l.customerAdvice ?? <span className="text-muted-foreground">+ Add note</span>}
        </button>
      ),
    },
    {
      // One menu, the same as the sales list: three buttons per row spent
      // ~240px on actions that get used once each per lead, on a table that
      // was already running off the right of the screen.
      key: "actions",
      header: "",
      cardFullWidth: true,
      cell: (l) => {
        const canCreateCustomer = perms.canAddCustomer && !l.convertedCustomerId;
        if (!perms.canAdd && !perms.canDelete && !canCreateCustomer) return null;
        return (
          <div className="flex items-center justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="More actions"
                    title="More actions"
                    disabled={busyId === l.id}
                  />
                }
              >
                <MoreVertical className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {perms.canAdd && (
                  <DropdownMenuItem onClick={() => openEdit(l)}>Edit</DropdownMenuItem>
                )}
                {canCreateCustomer && (
                  <DropdownMenuItem onClick={() => onCreateCustomer(l)}>
                    Add as customer
                  </DropdownMenuItem>
                )}
                {perms.canAdd &&
                  (l.orderId ? (
                    <DropdownMenuItem onClick={() => onUnlink(l)}>Unlink order</DropdownMenuItem>
                  ) : (
                    /* For the backlog: orders entered before the two lists
                       were linked at all. New ones link themselves. */
                    <DropdownMenuItem onClick={() => openLink(l)}>
                      Link an existing order
                    </DropdownMenuItem>
                  ))}
                {perms.canDelete && (
                  <DropdownMenuItem variant="destructive" onClick={() => onDelete(l)}>
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="relative w-full max-w-xs">
          <Input
            placeholder="Search name, phone, order…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className={search ? "pr-8" : undefined}
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                if (searchDebounce.current) clearTimeout(searchDebounce.current);
                setSearch("");
                pushSearch("");
              }}
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
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
        // The order's own state wins when there is one — an entered order that
        // was cancelled is a bigger fact than how the call went — and the call
        // outcome tints the rest.
        rowTone={(l) => LEAD_FULFILMENT_ROW_TONE[l.fulfilment] ?? CALL_ROW_TONE[l.callStatus]}
        rows={filtered}
        rowKey={(l) => l.id}
        colorGroupBy={(l) => l.date}
        colorToggleLabel="Color by date"
        empty={{
          icon: PhoneCall,
          title:
            query || active > 0 ? "No orders match these filters" : "No online orders yet",
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
              {/* Above the contact fields because it fills them in: a repeat
                  buyer is found once and the three below stop being typing.
                  Optional throughout — a new caller has no record yet, so the
                  fields stay editable whether or not anything is picked. */}
              {perms.canViewCustomers && (
                <div className="grid content-start gap-1.5 sm:col-span-2">
                  <Label htmlFor="lead-customer">Existing customer</Label>
                  <AsyncCombobox
                    id="lead-customer"
                    value={customer}
                    onChange={onPickCustomer}
                    fetchPage={async (q, cursor) => {
                      const res = await searchCustomers(slug, q, cursor);
                      return res.ok
                        ? { items: res.items, next: res.next }
                        : { items: [], next: null };
                    }}
                    placeholder="Search name or phone — or just type the details below"
                    emptyText="No customers"
                  />
                  {customer && (
                    <p className="text-xs text-muted-foreground">
                      Linked — this order counts towards their history, and the details
                      below can still be corrected for this one.
                    </p>
                  )}
                </div>
              )}
              <div className="grid content-start gap-1.5">
                <Label htmlFor="customerName">Customer name</Label>
                <Input
                  id="customerName"
                  name="customerName"
                  required
                  maxLength={120}
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
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
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
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
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
              {/* A product search, a quantity and a delete button per row —
                  half a dialog isn't enough for that at any width. */}
              <div className="sm:col-span-2">
                <LeadItemsEditor slug={slug} rows={itemRows} onChange={setItemRows} />
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="deliveryCharge">Delivery charge</Label>
                <Input
                  id="deliveryCharge"
                  name="deliveryCharge"
                  type="number"
                  step="0.01"
                  min="0"
                  value={delivery}
                  onChange={(e) => setDelivery(e.target.value)}
                />
                {/* Works from whichever end is known. A catalogue order adds
                    its items up and delivery on top; a phone order with
                    free-typed items has no price to add, so the split is read
                    back out of the total the caller agreed. */}
                {breakdown && (
                  <p className="text-xs text-muted-foreground">
                    Products <Money value={breakdown.goods} /> + delivery{" "}
                    <Money value={breakdown.delivery} />
                  </p>
                )}
              </div>
              <div className="grid content-start gap-1.5">
                <Label htmlFor="total">Total (with delivery)</Label>
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
                    Use <Money value={suggestedTotal} />
                    {deliveryAmount > 0 ? " (products + delivery)" : " from the items"}
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

/**
 * "This number has ordered before" — and how those orders went.
 *
 * Shown next to the name because that's where the caller's eye already is when
 * the phone starts ringing. A cancellation count is the part worth acting on:
 * a number that has refused two COD parcels is a different conversation from a
 * returning buyer, and the app knew both facts already without ever putting
 * them in front of the person making the call.
 *
 * Nothing renders for a first-time buyer. Most rows are first-time buyers, and
 * a badge on every one of them would say nothing.
 */
function RepeatBadge({ history }: { history: BuyerHistory | null }) {
  if (!history) return null;

  const parts = [
    `${history.previous} previous order${history.previous === 1 ? "" : "s"}`,
    history.delivered > 0 ? `${history.delivered} delivered` : null,
    history.cancelled > 0 ? `${history.cancelled} cancelled` : null,
  ].filter(Boolean);

  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary" title={parts.join(" · ")}>
        <Repeat2 className="size-3" aria-hidden />
        {history.previous}
      </Badge>
      {/* Separate from the count, and destructive, because it is the one part
          that should change what the caller does before shipping COD. */}
      {history.cancelled > 0 && (
        <Badge variant="destructive" title={`${history.cancelled} cancelled before`}>
          {history.cancelled} cancelled
        </Badge>
      )}
    </span>
  );
}
