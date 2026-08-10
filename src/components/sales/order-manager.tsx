"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  createOrder,
  updateOrderStatus,
  updateOrderHeader,
  updatePaymentStatus,
  updateCourierTrackingId,
  createReturn,
  deleteOrder,
  setOrderSource,
} from "@/server/actions/orders";
import { linkLeadToOrder } from "@/server/actions/leads";
import {
  createCustomer,
  customerContact,
  findCustomerByPhone,
} from "@/server/actions/customers";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AsyncCombobox, type ComboOption } from "@/components/ui/async-combobox";
import {
  searchVariants,
  searchCustomers,
  type VariantOption as SearchVariantOption,
} from "@/server/actions/search";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ANY_VALUE, UrlFilterBar, type FilterDef } from "@/components/ui/filter-bar";
import { ORDER_SOURCES, ORDER_SOURCE_LABEL } from "@/lib/order-source";
import { OrderSourceCell } from "@/components/sales/order-source-cell";
import { OrderCampaignCell, type CampaignOption } from "@/components/sales/order-campaign-cell";
import { quoteCourier, breakEvenDeliveryCharge, type CourierRules } from "@/lib/courier";
import { Columns3, Plus, Printer, ShoppingCart, Trash2, MoreVertical, X } from "lucide-react";
import { formatStock } from "@/lib/units";
import { cn } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { formatMoney } from "@/lib/money";
import { Field } from "@/components/ui/field";
import { MoneyInput } from "@/components/ui/money-input";

type VariantOption = { id: string; label: string; stock: number };
type OrderItem = {
  id: string;
  label: string;
  quantity: number;
  returnedQty: number;
  remaining: number;
  unitPrice: number;
};
type OrderRow = {
  id: string;
  date: string;
  customerId: string | null;
  customerName: string;
  /** Who this parcel was addressed to — the snapshot, or the customer record. */
  recipientName: string;
  customerPhone: string | null;
  customerAddress: string | null;
  /** This order's own delivery details; null = same as the customer record. */
  shipName: string | null;
  shipPhone: string | null;
  shipAddress: string | null;
  status: string;
  deliveryType: string;
  courierTrackingId: string | null;
  paymentStatus: string;
  /** Only meaningful while paymentStatus is PARTIAL. */
  amountPaid: number;
  /** Customer total less whatever has been paid towards it. */
  amountDue: number;
  paymentMethod: string;
  source: string | null;
  boostCampaignId: string | null;
  /** True once this PAID order's cash was marked deposited in the treasury. */
  cashInTreasury: boolean;
  deliveryCharge: number;
  deliveryCost: number | null;
  courierId: string | null;
  courierZoneId: string | null;
  weightKg: number | null;
  cancelledCollected: number;
  packagingCost: number;
  giftCost: number;
  discount: number;
  notes: string | null;
  heldByName: string | null;
  heldByMembershipId: string | null;
  totals: { customerTotal: number; netProfit: number; returnedUnits: number };
  gifts: { label: string; quantity: number }[];
  items: OrderItem[];
};
/** A cleared delivery block. Module scope: both dialogs read it. */
const EMPTY_SHIP = { name: "", phone: "", address: "" };

type Perms = { canAdd: boolean; canEdit: boolean; canViewProfit: boolean };
/** A courier's rules plus its zones — everything quoteCourier needs. */
export type CourierOption = CourierRules & {
  id: string;
  name: string;
  isDefault: boolean;
  zones: { id: string; name: string; rate: number }[];
};
/** A call-list row the sales page was sent here to turn into an order. */
export type FromLead = {
  leadId: string;
  customerId: string | null;
  customerName: string;
  phone: string;
  /** What the caller wrote down — free text, so it's shown, not auto-added. */
  itemsText: string;
  /** The lead's channel, prefilled onto the order's "came from". */
  channel: string | null;
  address: string | null;
  total: number;
};
type ItemDraft = {
  variant: SearchVariantOption | null;
  unitPrice: string;
  quantity: string;
  discount: string;
  // Pack-based products can be sold by the packet — quantity/price entered
  // per packet get converted to per-piece on submit (stock stays in pieces).
  unit: "PIECE" | "PACK";
};
// A gift line: either a product from stock (cost auto-filled from the latest
// purchase cost, editable) or a custom free-text item with a manual cost.
// Never shown on the invoice. costEdited marks that the user typed their own
// cost, so the server keeps it instead of re-snapshotting.
type GiftDraft = {
  mode: "PRODUCT" | "CUSTOM";
  variant: SearchVariantOption | null;
  label: string;
  quantity: string;
  unitCost: string;
  costEdited: boolean;
};

// Toggleable columns on the orders table (Columns menu). Profit starts on;
// the rest start hidden to keep the table lean.
//
// Every optional column belongs here, including ones only some workspaces can
// use (see availability below). Marking a column `hideable` on the DataTable
// instead would work, but it switches on DataTable's OWN Columns menu — and
// this page keeps its own toolbar, so the table would grow a second Columns
// button beside the first.
const OPTIONAL_COLUMNS = [
  { key: "heldBy", label: "Held by" },
  { key: "courier", label: "Courier ID" },
  { key: "campaign", label: "Campaign" },
  { key: "profit", label: "Profit" },
] as const;

const STATUSES = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"];

/**
 * Tints the status control so a long list is scannable without reading it.
 *
 * Same palette as the call list's fulfilment column, because it is the same
 * fact seen from two pages — an order that reads red there has to read red
 * here, or the two screens teach different habits about the same colour.
 */
const STATUS_TONE: Record<string, string> = {
  PENDING: "border-muted-foreground/30",
  CONFIRMED: "border-sky-500/60 text-sky-700 dark:text-sky-400",
  PACKED: "border-indigo-500/60 text-indigo-700 dark:text-indigo-400",
  SHIPPED: "border-violet-500/60 text-violet-700 dark:text-violet-400",
  DELIVERED: "border-emerald-500/60 text-emerald-700 dark:text-emerald-400",
  // The one that cost money: filled, not merely outlined, so it is found by
  // colour alone. The parcel went out, came back, and the courier charged for
  // the round trip.
  CANCELLED:
    "border-red-500/60 bg-red-500/10 font-medium text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * Payment, tinted by what it asks of the reader.
 *
 * Not "colour everything" — the useful question in this column is who still
 * owes money, so PAID is the quietest of the three. UNPAID is the normal
 * resting state of a COD order that hasn't been delivered yet, so it warns
 * rather than alarms; PARTIAL is the odd one, money half-arrived, and it is
 * the one worth a second look.
 */
const PAY_TONE: Record<string, string> = {
  PAID: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
  PARTIAL: "border-amber-500/60 font-medium text-amber-700 dark:text-amber-400",
  UNPAID: "border-rose-400/50 text-rose-700 dark:text-rose-400",
};

/** A faint tint for the whole row — one control in one column is easy to skim past. */
const ROW_TONE: Record<string, string | undefined> = {
  CANCELLED: "border-l-red-500 bg-red-500/5 dark:bg-red-500/10",
};
const DELIVERY = ["SELF", "COURIER"];
const METHODS = ["CASH", "BKASH", "NAGAD", "COURIER_COLLECTION", "OTHER"];
const PAY_STATUS = ["UNPAID", "PAID", "PARTIAL"];
const NONE = "__none__";

/**
 * Packaging cost on an order, with a nudge when it isn't zero.
 *
 * Packaging is bought in bulk and recorded once under Internal purchases, where
 * the whole amount comes off profit in the period it was paid for. Filling this
 * in as well charges the same money a second time — which is how 123 taka came
 * off twice across twenty orders before anyone noticed.
 *
 * The field stays rather than being removed: an order whose packaging really was
 * bought separately still needs somewhere to say so. It just says what it costs
 * you to use it.
 */
function PackagingCostField({
  id,
  value,
  onChange,
  hint,
  required,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  required?: boolean;
}) {
  const amount = parseFloat(value);
  const entered = Number.isFinite(amount) && amount > 0;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Packaging cost</Label>
      <Input
        id={id}
        name="packagingCost"
        type="number"
        step="0.01"
        min="0"
        inputMode="decimal"
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {/* This used to warn that entering a figure here double-counted the
          packaging, which it did — profit subtracted both this and the whole
          internal purchase that bought the material. The subtraction is gone
          now, so the field is a record of what a parcel used rather than a
          trap, and it says so plainly. */}
      {entered ? (
        <p className="text-xs text-muted-foreground">
          Recorded for this order, not charged to profit again — the material is
          already an expense from when it was bought under Internal purchases.
        </p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function emptyItem(): ItemDraft {
  return { variant: null, unitPrice: "", quantity: "1", discount: "0", unit: "PIECE" };
}

/**
 * Prefill for the price box from the variant's recorded sale price, in the
 * selected unit (per-piece × unitsPerPack when selling by packet). Empty when
 * no sale price was ever recorded — seller types it as before.
 */
function prefillPrice(variant: SearchVariantOption | null, unit: "PIECE" | "PACK"): string {
  if (variant?.salePrice == null) return "";
  const upp = variant.unitsPerPack && variant.unitsPerPack > 1 ? variant.unitsPerPack : 1;
  const perUnit = unit === "PACK" ? variant.salePrice * upp : variant.salePrice;
  return String(Math.round((perUnit + Number.EPSILON) * 100) / 100);
}

/** Units-per-pack for a draft's selected variant, or null when not pack-based. */
function uppOf(it: { variant: SearchVariantOption | null }): number | null {
  const v = it.variant;
  return v?.unitsPerPack && v.unitsPerPack > 1 ? v.unitsPerPack : null;
}

function emptyGift(): GiftDraft {
  return { mode: "PRODUCT", variant: null, label: "", quantity: "1", unitCost: "0", costEdited: false };
}

function todayInputValue() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function formatEnum(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Inline click-to-edit courier order/consignment number — usually unknown
 * at order creation time and filled in later once the courier is booked. */
function CourierIdCell({
  slug,
  orderId,
  value,
  canEdit,
}: {
  slug: string;
  orderId: string;
  value: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const res = await updateCourierTrackingId(slug, orderId, draft);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    setEditing(false);
    router.refresh();
  }

  if (!canEdit) {
    return <span>{value ?? "—"}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        className="text-left underline-offset-4 hover:underline"
      >
        {value ?? <span className="text-muted-foreground">Add courier ID</span>}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="h-8 w-32"
      />
      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? "…" : "Save"}
      </Button>
    </div>
  );
}

export function OrderManager({
  slug,
  hasProducts,
  members,
  campaigns,
  couriers,
  fromLead,
  orders,
  perms,
  query,
  statusFilter,
  payFilter,
  sort,
  listFilters,
  matchCount,
}: {
  slug: string;
  hasProducts: boolean;
  members: { id: string; label: string }[];
  /** Campaigns worth tagging an order to — empty when boosting isn't used. */
  campaigns: CampaignOption[];
  /** Courier rules, so the form can price a parcel as it's being written. */
  couriers: CourierOption[];
  /**
   * Set when the sales page was opened from a call-list row ("+ Order"): the
   * form opens filled in, and the order it creates links back to that lead.
   */
  fromLead: FromLead | null;
  orders: OrderRow[];
  perms: Perms;
  query: string;
  statusFilter: string;
  payFilter: string;
  sort: string;
  listFilters: Record<string, string>;
  /** Counted server-side across every page, not just the rows handed here. */
  matchCount: { shown: number; total: number };
}) {
  const router = useRouter();

  // ── New-order dialog state ──
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // The order awaiting a "what did this cancellation cost?" answer.
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  // Both dialogs used defaultValue before. The warning has to react as you
  // type, so the value is state now — seeded whenever the dialog opens.
  const [cancelPackaging, setCancelPackaging] = useState("0");
  const [cancelSaving, setCancelSaving] = useState(false);
  // The order awaiting a "how much of it have they paid?" answer. PARTIAL is
  // the one status that means nothing without a number attached.
  const [partPaying, setPartPaying] = useState<OrderRow | null>(null);
  const [partPaidAmount, setPartPaidAmount] = useState("");
  const [partPaySaving, setPartPaySaving] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [gifts, setGifts] = useState<GiftDraft[]>([]);
  const [customer, setCustomer] = useState<ComboOption | null>(null);
  const [heldById, setHeldById] = useState(NONE);
  const [status, setStatus] = useState("PENDING");
  const [deliveryType, setDeliveryType] = useState("SELF");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [paymentStatus, setPaymentStatus] = useState("UNPAID");
  /** Only submitted for PARTIAL — see the "Paid so far" field. */
  const [amountPaid, setAmountPaid] = useState("");
  const [deliveryCharge, setDeliveryCharge] = useState("0");
  const [deliveryCost, setDeliveryCost] = useState("");
  const [courierId, setCourierId] = useState<string>(
    () => couriers.find((c) => c.isDefault)?.id ?? NONE,
  );
  const [courierZoneId, setCourierZoneId] = useState<string>(NONE);
  const [weightKg, setWeightKg] = useState("");
  const [packagingCost, setPackagingCost] = useState("0");
  const [orderDiscount, setOrderDiscount] = useState("0");

  // ── Return dialog state ──
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnOrder, setReturnOrder] = useState<OrderRow | null>(null);
  const [returnItemId, setReturnItemId] = useState("");

  // ── Edit details dialog state ──
  const [editOpen, setEditOpen] = useState(false);
  const [editOrder, setEditOrder] = useState<OrderRow | null>(null);
  const [editPackaging, setEditPackaging] = useState("0");
  const [editHeldById, setEditHeldById] = useState<string>(NONE);
  const [editCourierId, setEditCourierId] = useState<string>(NONE);
  const [editCourierZoneId, setEditCourierZoneId] = useState<string>(NONE);
  const [editWeightKg, setEditWeightKg] = useState("");
  const [editCustomer, setEditCustomer] = useState<ComboOption | null>(null);
  const [editShip, setEditShip] = useState(EMPTY_SHIP);
  const [editDeliveryType, setEditDeliveryType] = useState("SELF");
  const [editPaymentMethod, setEditPaymentMethod] = useState("CASH");
  const [editSaving, setEditSaving] = useState(false);

  /**
   * Where this order is being delivered, which is not the same question as who
   * the customer is. The customer record is one row per phone number and holds
   * their whole history; a repeat buyer sending a parcel to their office, or to
   * a relative, is still that customer. Prefilled from their record and edited
   * freely — anything actually different is stored on the order, so no past
   * order is rewritten and no new one goes to a stale address.
   */
  const [ship, setShip] = useState(EMPTY_SHIP);

  /** Select a customer and pull their current details into the delivery block. */
  async function chooseCustomer(opt: ComboOption | null) {
    setCustomer(opt);
    if (!opt) return setShip(EMPTY_SHIP);
    const c = await customerContact(slug, opt.value);
    if (c) setShip({ name: c.name, phone: c.phone ?? "", address: c.address ?? "" });
  }

  // ── Inline "new customer" dialog (shortcut from the order form) ──
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newCustomerSaving, setNewCustomerSaving] = useState(false);

  async function onCreateCustomer(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);

    // A second row for a number that already has one splits that buyer's order
    // history and outstanding balance across two records — and hides how often
    // the number has cancelled, which is the thing worth knowing before a COD
    // parcel. The lead list already matches on phone before creating; this is
    // the other door into the same table.
    //
    // A warning and not a block, deliberately: a shared family or shop number
    // is a real thing (see lib/phone), and a hard rule would only teach people
    // to type a stray space to get past it.
    const typedPhone = String(fd.get("phone") ?? "").trim();
    if (typedPhone) {
      const existing = await findCustomerByPhone(slug, typedPhone);
      if (existing) {
        // Confirm is the separate record and cancel is the existing one, not
        // the other way round: dismissing with Escape lands on cancel, and the
        // outcome of a stray Escape must be the one that writes nothing.
        const addSeparate = await confirmDialog({
          title: "This number already has a customer",
          description: `${typedPhone} belongs to "${existing.name}". Adding a second record splits that buyer's order history between two rows.`,
          confirmText: "Add separate record",
          cancelText: `Use ${existing.name}`,
        });
        if (!addSeparate) {
          setCustomer({
            value: existing.id,
            label: existing.phone ? `${existing.name} · ${existing.phone}` : existing.name,
          });
          // Keep what was just typed rather than reloading the old record over
          // it. This is exactly the case the snapshot exists for: the same
          // buyer, a new name or address for this parcel. Overwriting here
          // silently threw away the address the person had come to enter.
          setShip({
            name: String(fd.get("name") ?? "").trim() || existing.name,
            phone: typedPhone || existing.phone || "",
            address: String(fd.get("address") ?? "").trim() || existing.address || "",
          });
          setNewCustomerOpen(false);
          toast.success(`Using "${existing.name}" — this order's delivery details kept`);
          return;
        }
      }
    }

    setNewCustomerSaving(true);
    const res = await createCustomer(slug, fd);
    setNewCustomerSaving(false);
    if (!res.ok) return toast.error(res.error ?? "Failed");
    // Select the fresh customer on the order right away (label matches the
    // search results' "Name · phone" format).
    if (res.id && res.name) {
      void chooseCustomer({
        value: res.id,
        label: res.phone ? `${res.name} · ${res.phone}` : res.name,
      });
    }
    toast.success("Customer added & selected");
    setNewCustomerOpen(false);
  }

  // ── List toolbar: URL-driven search/filter/sort (server queries all pages) ──
  const [search, setSearch] = useState(query);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set(["profit"]));
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  function pushListParams(next: {
    q?: string;
    status?: string;
    pay?: string;
    sort?: string;
    filters?: Record<string, string>;
  }) {
    const params = new URLSearchParams();
    const qv = (next.q ?? search).trim();
    const sv = next.status ?? statusFilter;
    const pv = next.pay ?? payFilter;
    const so = next.sort ?? sort;
    if (qv) params.set("q", qv);
    if (sv) params.set("status", sv);
    if (pv) params.set("pay", pv);
    if (so !== "date_desc") params.set("sort", so);
    for (const [k, v] of Object.entries(next.filters ?? listFilters)) if (v) params.set(k, v);
    router.replace(`/${slug}/sales/orders${params.size ? `?${params}` : ""}`);
  }

  // The bar names range endpoints "<key>:from"/"<key>:to"; the URL uses plain
  // names, so the two are mapped rather than one leaking into the other.
  const FILTER_DEFS: FilterDef<OrderRow>[] = [
    {
      key: "source",
      label: "Where it came from",
      kind: "select",
      options: ORDER_SOURCES.map((o) => ({ value: o, label: ORDER_SOURCE_LABEL[o] ?? o })),
    },
    {
      key: "delivery",
      label: "Delivery",
      kind: "select",
      options: [
        { value: "SELF", label: "Self delivery" },
        { value: "COURIER", label: "Courier" },
      ],
    },
    {
      key: "held",
      label: "Cash held by",
      kind: "select",
      options: [
        { value: "__none__", label: "Nobody assigned" },
        ...members.map((m) => ({ value: m.id, label: m.label })),
      ],
    },
    { key: "date", label: "Order date", kind: "dateRange" },
  ];
  const BAR_TO_URL: Record<string, string> = {
    source: "source",
    delivery: "delivery",
    held: "held",
    "date:from": "from",
    "date:to": "to",
  };
  const barState = Object.fromEntries(
    Object.entries(BAR_TO_URL).map(([bar, url]) => [bar, listFilters[url] ?? ""]),
  );
  function onFiltersChange(nextBar: Record<string, string>) {
    const filters: Record<string, string> = {};
    for (const [bar, url] of Object.entries(BAR_TO_URL)) {
      const v = nextBar[bar];
      if (v && v !== ANY_VALUE) filters[url] = v;
    }
    pushListParams({ filters });
  }
  function onSearchChange(v: string) {
    setSearch(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => pushListParams({ q: v }), 400);
  }
  useEffect(() => {
    return () => {
      if (searchDebounce.current) clearTimeout(searchDebounce.current);
    };
  }, []);

  function toggleColumn(key: string) {
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Not every optional column applies to every workspace: Profit needs reports
  // access, and Campaign has nothing to show until somebody runs an ad. Both
  // the menu and the table go through this, so an unavailable column can't be
  // offered in one place and rendered in the other.
  const columnAvailable = (c: { key: string }) => {
    if (c.key === "profit") return perms.canViewProfit;
    if (c.key === "campaign") return campaigns.length > 0;
    return true;
  };
  const showColumn = (key: string) =>
    visibleCols.has(key) && columnAvailable({ key });

  const shownOrders = orders;

  // Which orders are ticked for printing. Held here rather than inside
  // DataTable so paging or searching the list can't quietly drop them, and
  // pruned to what's actually on screen when the server sends a new page —
  // otherwise "Print 4 orders" could include two the user can no longer see.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    const visible = new Set(orders.map((o) => o.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [orders]);

  function changeSelection(ids: string[], selected: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  // Printed in the order they appear in the list, not the order they were
  // clicked — the person collating the printout reads it against the screen.
  const selectedInListOrder = shownOrders.filter((o) => selectedIds.has(o.id)).map((o) => o.id);
  const sheetCount = Math.ceil(selectedInListOrder.length / 2);

  // Arriving from a call-list row opens the order form already pointed at that
  // customer. Runs once: reopening the dialog after a save would be a trap,
  // and the URL still carries ?fromLead until the next navigation.
  const leadPrefilled = useRef(false);
  useEffect(() => {
    if (!fromLead || leadPrefilled.current || !perms.canAdd) return;
    leadPrefilled.current = true;
    if (fromLead.customerId) {
      setCustomer({ value: fromLead.customerId, label: fromLead.customerName });
    }
    // Deliberately the lead's details, not the linked customer's. A repeat
    // buyer who gave a new address on this order gave it to the caller, and
    // the customer record still holds the old one.
    setShip({
      name: fromLead.customerName,
      phone: fromLead.phone,
      address: fromLead.address ?? "",
    });
    // The call taker already agreed a price with the customer; the items are
    // free text and can't be matched to catalogue variants reliably, so the
    // total is offered and the lines are shown for the person to pick.
    setDeliveryType("COURIER");
    setOpen(true);
  }, [fromLead, perms.canAdd]);

  function resetForm() {
    setItems([emptyItem()]);
    setGifts([]);
    setCustomer(null);
    setShip(EMPTY_SHIP);
    setHeldById(NONE);
    setStatus("PENDING");
    setDeliveryType("SELF");
    setPaymentMethod("CASH");
    setPaymentStatus("UNPAID");
    setAmountPaid("");
    setDeliveryCharge("0");
    setDeliveryCost("");
    setCourierId(couriers.find((c) => c.isDefault)?.id ?? NONE);
    setCourierZoneId(NONE);
    setWeightKg("");
    setPackagingCost("0");
    setOrderDiscount("0");
  }

  const selectedCourier = couriers.find((c) => c.id === courierId) ?? null;

  /** Switching courier drops the zone: zones belong to one courier. */
  function onCourierChange(next: string) {
    setCourierId(next);
    setCourierZoneId(NONE);
  }

  // Weight from the items themselves, so nobody has to guess. Only offered
  // when EVERY line knows its own weight — a partial sum would be confidently
  // wrong and quietly under-quote the parcel.
  const suggestedWeightKg = useMemo(() => {
    const picked = items.filter((it) => it.variant);
    if (picked.length === 0) return null;
    let grams = 0;
    for (const it of picked) {
      const g = it.variant?.weightGrams;
      if (g == null) return null;
      grams += g * (parseInt(it.quantity) || 0);
    }
    return grams > 0 ? Math.round((grams / 1000) * 1000) / 1000 : null;
  }, [items]);

  // What the courier will actually keep, previewed while the charge is being
  // set rather than discovered on a statement weeks later.
  const courierQuote = useMemo(() => {
    if (deliveryType !== "COURIER" || !selectedCourier) return null;
    const zone = selectedCourier.zones.find((z) => z.id === courierZoneId);
    if (!zone) return null;
    const goods = items.reduce((s, it) => {
      const price = parseFloat(it.unitPrice) || 0;
      const qty = parseInt(it.quantity) || 0;
      return s + price * qty - (parseFloat(it.discount) || 0);
    }, 0);
    // Only what the courier itself collects carries the fee — a bKash
    // prepayment travels by courier too, but there's nothing to collect.
    const codAmount =
      paymentMethod === "COURIER_COLLECTION"
        ? goods - (parseFloat(orderDiscount) || 0) + (parseFloat(deliveryCharge) || 0)
        : 0;
    return quoteCourier(selectedCourier, {
      zoneRate: zone.rate,
      weightKg: parseFloat(weightKg) || suggestedWeightKg,
      codAmount,
    });
  }, [
    deliveryType,
    selectedCourier,
    courierZoneId,
    items,
    orderDiscount,
    deliveryCharge,
    weightKg,
    suggestedWeightKg,
    paymentMethod,
  ]);

  const deliveryShortfall = courierQuote
    ? Math.round((courierQuote.total - (parseFloat(deliveryCharge) || 0)) * 100) / 100
    : 0;

  const breakEven = useMemo(() => {
    if (!courierQuote || !selectedCourier) return null;
    const zone = selectedCourier.zones.find((z) => z.id === courierZoneId);
    if (!zone) return null;
    const goods = items.reduce((s, it) => {
      const price = parseFloat(it.unitPrice) || 0;
      const qty = parseInt(it.quantity) || 0;
      return s + price * qty - (parseFloat(it.discount) || 0);
    }, 0);
    return breakEvenDeliveryCharge(selectedCourier, {
      zoneRate: zone.rate,
      weightKg: parseFloat(weightKg) || suggestedWeightKg,
      goodsAmount: goods - (parseFloat(orderDiscount) || 0),
    });
  }, [courierQuote, selectedCourier, courierZoneId, items, orderDiscount, weightKg, suggestedWeightKg]);

  const editCourier = couriers.find((c) => c.id === editCourierId) ?? null;
  const editCourierQuote = useMemo(() => {
    if (!editOrder || editDeliveryType !== "COURIER" || !editCourier) return null;
    const zone = editCourier.zones.find((z) => z.id === editCourierZoneId);
    if (!zone) return null;
    const goods = editOrder.totals.customerTotal - editOrder.deliveryCharge;
    return quoteCourier(editCourier, {
      zoneRate: zone.rate,
      weightKg: parseFloat(editWeightKg) || null,
      // A cancelled parcel collected nothing to be charged a percentage on.
      codAmount:
        editOrder.status === "CANCELLED" || editPaymentMethod !== "COURIER_COLLECTION"
          ? 0
          : goods + editOrder.deliveryCharge,
    });
  }, [editOrder, editDeliveryType, editCourier, editCourierZoneId, editWeightKg, editPaymentMethod]);

  const preview = useMemo(() => {
    const itemsSubtotal = items.reduce((s, it) => {
      const price = parseFloat(it.unitPrice) || 0;
      const qty = parseInt(it.quantity) || 0;
      const disc = parseFloat(it.discount) || 0;
      return s + price * qty - disc;
    }, 0);
    const customerTotal =
      itemsSubtotal + (parseFloat(deliveryCharge) || 0) - (parseFloat(orderDiscount) || 0);
    // Product gifts prefill their cost from the latest purchase cost (still
    // editable), so every gift line's cost is known client-side for preview.
    const giftCostPreview = gifts.reduce(
      (s, g) => s + (parseFloat(g.unitCost) || 0) * (parseInt(g.quantity) || 0),
      0,
    );
    const costPreview =
      (parseFloat(packagingCost) || 0) +
      giftCostPreview +
      (deliveryType === "COURIER" ? parseFloat(deliveryCost || deliveryCharge) || 0 : 0);

    return { itemsSubtotal, customerTotal, costPreview };
  }, [deliveryCharge, deliveryCost, deliveryType, gifts, items, orderDiscount, packagingCost]);

  function updateGift(i: number, patch: Partial<GiftDraft>) {
    setGifts((prev) => prev.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  }

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
    const cleanItems = items
      .filter((it) => it.variant && parseInt(it.quantity) > 0)
      .map((it) => {
        // Packet entries → per-piece storage: qty × upp, price ÷ upp.
        const upp = it.unit === "PACK" ? uppOf(it) : null;
        const qty = parseInt(it.quantity) || 0;
        const price = parseFloat(it.unitPrice) || 0;
        return {
          productVariantId: it.variant!.value,
          unitPrice: upp ? round2(price / upp) : price,
          quantity: upp ? qty * upp : qty,
          discount: parseFloat(it.discount) || 0,
        };
      });
    if (cleanItems.length === 0) {
      toast.error("Add at least one item with a product and quantity");
      return;
    }
    const cleanGifts = gifts
      .filter((g) =>
        g.mode === "PRODUCT" ? g.variant && parseInt(g.quantity) > 0 : g.label.trim() && parseInt(g.quantity) > 0,
      )
      .map((g) => ({
        productVariantId: g.mode === "PRODUCT" ? g.variant!.value : "",
        label: g.mode === "CUSTOM" ? g.label.trim() : "",
        quantity: parseInt(g.quantity) || 1,
        unitCost: parseFloat(g.unitCost) || 0,
        // Product gift with an untouched cost → server re-snapshots; a typed
        // cost (or any custom gift) is kept as-is.
        costOverridden: g.mode === "CUSTOM" || g.costEdited,
      }));
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("customerId", customer?.value ?? "");
    fd.set("heldByMembershipId", heldById === NONE ? "" : heldById);
    fd.set("status", status);
    fd.set("deliveryType", deliveryType);
    fd.set("paymentMethod", paymentMethod);
    fd.set("paymentStatus", paymentStatus);
    fd.set("items", JSON.stringify(cleanItems));
    fd.set("gifts", JSON.stringify(cleanGifts));
    const res = await createOrder(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    // Point the call-list row at the order it just became, so that list can
    // show where the parcel got to without anyone re-typing it. A failure here
    // costs the link, not the order — say so rather than implying both failed.
    if (fromLead && res.id) {
      const linked = await linkLeadToOrder(slug, fromLead.leadId, res.id);
      // The lead already knows which channel the customer came through, and
      // the order form has no field for it — carry it across rather than
      // leaving one more order tagged "Not set".
      if (fromLead.channel) await setOrderSource(slug, res.id, fromLead.channel);
      if (!linked.ok) {
        toast.error(`Order created, but linking it to the call list failed: ${linked.error}`);
      } else {
        toast.success("Order created and linked to the call list");
      }
    } else {
      toast.success("Order created");
    }
    // Not an error — the order is saved either way — but a sale with no cost
    // behind it reports as pure profit, and the moment to say so is now, while
    // whoever entered it is still looking.
    if (res.warning) toast.warning(res.warning, { duration: 10000 });
    setOpen(false);
    resetForm();
    router.refresh();
  }

  async function onStatusChange(orderId: string, newStatus: string) {
    // Cancelling asks what it cost before it happens: once the row says
    // CANCELLED nobody goes back to record the courier's return charge, and
    // an uncosted cancellation reads as free in every report.
    if (newStatus === "CANCELLED") {
      const order = orders.find((o) => o.id === orderId);
      if (order && order.status !== "CANCELLED") {
        setCancelPackaging(String(order.packagingCost));
        setCancelling(order);
        return;
      }
    }
    const res = await updateOrderStatus(slug, orderId, newStatus);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Order → ${newStatus}`);
    router.refresh();
  }

  async function onConfirmCancel(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!cancelling) return;
    const fd = new FormData(e.currentTarget);
    setCancelSaving(true);
    const res = await updateOrderStatus(slug, cancelling.id, "CANCELLED", {
      packagingCost: String(fd.get("packagingCost") ?? "0"),
      giftCost: String(fd.get("giftCost") ?? "0"),
      deliveryCost: String(fd.get("deliveryCost") ?? "0"),
      cancelledCollected: String(fd.get("cancelledCollected") ?? "0"),
    });
    setCancelSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Order cancelled");
    setCancelling(null);
    router.refresh();
  }

  async function onPaymentStatusChange(orderId: string, newStatus: string) {
    // "Some of it" is not an amount, and every due figure needs one. Ask now,
    // while whoever took the money is still standing there.
    if (newStatus === "PARTIAL") {
      const order = orders.find((o) => o.id === orderId);
      if (order) {
        setPartPaidAmount(order.amountPaid > 0 ? String(order.amountPaid) : "");
        setPartPaying(order);
        return;
      }
    }
    const res = await updatePaymentStatus(slug, orderId, newStatus);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Payment → ${newStatus}`);
    router.refresh();
  }

  async function onConfirmPartial(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!partPaying) return;
    setPartPaySaving(true);
    const res = await updatePaymentStatus(
      slug,
      partPaying.id,
      "PARTIAL",
      parseFloat(partPaidAmount) || 0,
    );
    setPartPaySaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Partial payment recorded");
    setPartPaying(null);
    router.refresh();
  }

  async function onDelete(orderId: string) {
    const ok = await confirmDialog({
      title: "Delete order?",
      description: "The order, its items, and any gifts are permanently removed; stock is restored.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteOrder(slug, orderId);
    if (!res.ok) return toast.error(res.error);
    toast.success("Order deleted");
    router.refresh();
  }

  function openReturn(o: OrderRow) {
    const firstReturnable = o.items.find((it) => it.remaining > 0);
    setReturnOrder(o);
    setReturnItemId(firstReturnable?.id ?? "");
    setReturnOpen(true);
  }

  async function onSubmitReturn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!returnItemId) return toast.error("Select an item to return");
    const fd = new FormData(e.currentTarget);
    fd.set("orderItemId", returnItemId);
    const res = await createReturn(slug, fd);
    if (!res.ok) return toast.error(res.error);
    toast.success("Return recorded");
    setReturnOpen(false);
    router.refresh();
  }

  function openEdit(o: OrderRow) {
    setEditPackaging(String(o.packagingCost));
    setEditOrder(o);
    setEditCustomer(o.customerId ? { value: o.customerId, label: o.customerName } : null);
    // The snapshot where there is one, the customer record where there isn't —
    // the same fallback the documents use, so what's edited is what prints.
    setEditShip({
      name: o.shipName ?? o.customerName ?? "",
      phone: o.shipPhone ?? o.customerPhone ?? "",
      address: o.shipAddress ?? o.customerAddress ?? "",
    });
    setEditDeliveryType(o.deliveryType);
    setEditPaymentMethod(o.paymentMethod);
    setEditHeldById(o.heldByMembershipId ?? NONE);
    setEditCourierId(o.courierId ?? NONE);
    setEditCourierZoneId(o.courierZoneId ?? NONE);
    setEditWeightKg(o.weightKg != null ? String(o.weightKg) : "");
    setEditOpen(true);
  }

  async function onSubmitEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editOrder) return;
    setEditSaving(true);
    const fd = new FormData(e.currentTarget);
    fd.set("customerId", editCustomer?.value ?? "");
    fd.set("deliveryType", editDeliveryType);
    fd.set("paymentMethod", editPaymentMethod);
    fd.set("heldByMembershipId", editHeldById === NONE ? "" : editHeldById);
    const res = await updateOrderHeader(slug, editOrder.id, fd);
    setEditSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Order updated");
    setEditOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Input
              placeholder="Search customer or courier ID…"
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
                  pushListParams({ q: "" });
                }}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
          <Select
            value={statusFilter || "__all__"}
            onValueChange={(v) => pushListParams({ status: v === "__all__" ? "" : (v ?? "") })}
          >
            <SelectTrigger className="w-44">
              <span className="shrink-0 text-muted-foreground">Status:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {formatEnum(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={payFilter || "__all__"}
            onValueChange={(v) => pushListParams({ pay: v === "__all__" ? "" : (v ?? "") })}
          >
            <SelectTrigger className="w-40">
              <span className="shrink-0 text-muted-foreground">Payment:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              {PAY_STATUS.map((s) => (
                <SelectItem key={s} value={s}>
                  {formatEnum(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => v && pushListParams({ sort: v })}>
            <SelectTrigger className="w-44">
              <span className="shrink-0 text-muted-foreground">Sort:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date_desc">Newest first</SelectItem>
              <SelectItem value="date_asc">Oldest first</SelectItem>
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              <Columns3 data-icon="inline-start" />
              Columns
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {OPTIONAL_COLUMNS.filter(columnAvailable).map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={visibleCols.has(c.key)}
                  onCheckedChange={() => toggleColumn(c.key)}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {perms.canAdd && (
          <Button
            size="sm"
            onClick={() => {
              resetForm();
              setOpen(true);
            }}
          >
            + New order
          </Button>
        )}
      </div>

      <UrlFilterBar
        defs={FILTER_DEFS}
        state={barState}
        onChange={onFiltersChange}
        count={matchCount}
      />

      <DataTable
        rows={shownOrders}
        rowKey={(o) => o.id}
        selection={{
          selected: selectedIds,
          onChange: changeSelection,
          label: "Select all orders on this page",
        }}
        rowTone={(o) => ROW_TONE[o.status]}
        colorGroupBy={(o) => o.date}
        colorToggleLabel="Color by date"
        empty={{
          icon: ShoppingCart,
          title:
            query || statusFilter || payFilter || Object.values(listFilters).some(Boolean)
              ? "No orders match your filters"
              : "No orders found",
          description: perms.canAdd ? "Create an order to start selling." : undefined,
        }}
        columns={
          [
            {
              // First so the mobile card leads with its title line.
              key: "customer",
              header: "Customer",
              cardTitle: true,
              cell: (o) => (
                <span>
                  {o.recipientName}
                  {/* Only when the two disagree: the row is findable by the
                      name it shipped under, and the buyer it belongs to is
                      still visible underneath. */}
                  {o.recipientName !== o.customerName && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (account: {o.customerName})
                    </span>
                  )}
                  {o.gifts.length > 0 && (
                    <span
                      className="ml-1.5 text-xs"
                      title={o.gifts.map((g) => `${g.label} ×${g.quantity}`).join(", ")}
                    >
                      🎁
                    </span>
                  )}
                </span>
              ),
            },
            { key: "date", header: "Date", cell: (o) => o.date },
            {
              key: "status",
              header: "Status",
              cell: (o) =>
                perms.canEdit ? (
                  <Select value={o.status} onValueChange={(v) => v && onStatusChange(o.id, v)}>
                    <SelectTrigger className={cn("h-8 w-36", STATUS_TONE[o.status])}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge variant="secondary" className={cn(STATUS_TONE[o.status])}>
                    {o.status}
                  </Badge>
                ),
            },
            {
              key: "payment",
              header: "Payment",
              cell: (o) => (
                // Wraps in the mobile card (narrow value area) but stays a
                // single line in the desktop table.
                <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 md:flex-nowrap md:justify-start">
                  {perms.canEdit ? (
                    <Select
                      value={o.paymentStatus}
                      onValueChange={(v) => v && onPaymentStatusChange(o.id, v)}
                    >
                      <SelectTrigger className={cn("h-8 w-28", PAY_TONE[o.paymentStatus])}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PAY_STATUS.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className={cn(PAY_TONE[o.paymentStatus])}>{o.paymentStatus}</span>
                  )}
                  <span className="whitespace-nowrap text-muted-foreground">
                    · {formatEnum(o.paymentMethod)}
                  </span>
                  {/* A part-paid order that shows only "PARTIAL" tells nobody
                      what is still owed, which is the only part that matters. */}
                  {o.paymentStatus === "PARTIAL" && (
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      <Money value={o.amountPaid} /> paid · <Money value={o.amountDue} /> due
                    </span>
                  )}
                  {o.totals.returnedUnits > 0 && (
                    <Badge variant="outline">{o.totals.returnedUnits} returned</Badge>
                  )}
                </div>
              ),
            },
            ...(showColumn("heldBy")
              ? [{ key: "heldBy", header: "Held by", cell: (o: OrderRow) => o.heldByName ?? "—" }]
              : []),
            ...(showColumn("courier")
              ? [
                  {
                    key: "courier",
                    header: "Courier ID",
                    cell: (o: OrderRow) =>
                      o.deliveryType === "COURIER" ? (
                        <CourierIdCell
                          slug={slug}
                          orderId={o.id}
                          value={o.courierTrackingId}
                          canEdit={perms.canEdit}
                        />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      ),
                  },
                ]
              : []),
            {
              key: "source",
              header: "Came from",
              cell: (o) => (
                <OrderSourceCell
                  slug={slug}
                  orderId={o.id}
                  value={o.source}
                  canEdit={perms.canEdit}
                />
              ),
            },
            // Off by default: only shops that run ads care, and they can turn
            // the column on from Columns.
            ...(showColumn("campaign")
              ? [
                  {
                    key: "campaign",
                    header: "Campaign",
                    cell: (o: OrderRow) => (
                      <OrderCampaignCell
                        slug={slug}
                        orderId={o.id}
                        value={o.boostCampaignId}
                        campaigns={campaigns}
                        canEdit={perms.canEdit}
                      />
                    ),
                  },
                ]
              : []),
            {
              key: "total",
              header: "Total",
              align: "right",
              cell: (o) => <Money value={o.totals.customerTotal} />,
            },
            ...(showColumn("profit")
              ? [
                  {
                    key: "profit",
                    header: "Profit",
                    align: "right" as const,
                    // A cancelled order's figure is not a trading margin —
                    // nothing was sold — it's what was left after the
                    // cancellation, so it's marked rather than shown as if it
                    // were an ordinary sale.
                    cell: (o: OrderRow) =>
                      o.status === "CANCELLED" ? (
                        <span
                          className="text-muted-foreground"
                          title="Cancelled: collected on a partial delivery, less the courier's return charge and any gift. Nothing was sold."
                        >
                          <Money value={o.totals.netProfit} />
                        </span>
                      ) : (
                        <Money value={o.totals.netProfit} />
                      ),
                  },
                ]
              : []),
            {
              key: "actions",
              header: "",
              cardFullWidth: true,
              cell: (o: OrderRow) => (
                <div className="flex flex-nowrap items-center gap-3">
                  <Link
                    href={`/${slug}/sales/orders/${o.id}/invoice`}
                    className="inline-flex items-center whitespace-nowrap text-sm underline underline-offset-4"
                  >
                    Invoice
                  </Link>
                  {perms.canViewProfit && (
                    <Link
                      href={`/${slug}/sales/orders/${o.id}/breakdown`}
                      className="inline-flex items-center whitespace-nowrap text-sm underline underline-offset-4"
                    >
                      Breakdown
                    </Link>
                  )}
                  {perms.canEdit && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions" />}
                      >
                        <MoreVertical className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(o)}>Edit details</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openReturn(o)}>Return</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => onDelete(o.id)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              ),
            },
          ] as Column<OrderRow>[]
        }
      />

      {/* Bulk-print bar. Fixed to the bottom of the viewport rather than
          placed after the table: on a 50-row list the user ticks a row near
          the top and would otherwise have to scroll to the end to find out
          what they can do with it. */}
      {selectedInListOrder.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 p-3 shadow-lg backdrop-blur print:hidden">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3">
            <span className="text-sm">
              <strong>{selectedInListOrder.length}</strong> selected ·{" "}
              <span className="text-muted-foreground">
                {sheetCount} A4 sheet{sheetCount === 1 ? "" : "s"}
                {selectedInListOrder.length % 2 === 1 && ", last one half blank"}
              </span>
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                Clear
              </Button>
              <Link
                href={`/${slug}/sales/orders/forms?ids=${selectedInListOrder.join(",")}`}
                target="_blank"
                className={buttonVariants({ size: "sm" })}
              >
                <Printer data-icon="inline-start" />
                Print order forms
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* New order dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[92dvh] max-w-[min(96vw,980px)] flex-col overflow-hidden p-0 sm:max-w-[min(96vw,980px)]">
          <DialogHeader className="shrink-0 border-b bg-muted/30 px-4 py-4 pr-14 sm:px-5">
            <DialogTitle className="text-lg">
              {fromLead ? `New order for ${fromLead.customerName}` : "New order"}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Add products first, then payment and delivery details.
            </p>
            {/* What the caller wrote down, shown rather than auto-added: lead
                items are free text and a wrong catalogue match would put the
                wrong cost on the order and take the wrong item out of stock. */}
            {fromLead && (
              <div className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
                <div className="font-medium">From the call list</div>
                <div className="text-muted-foreground">
                  {fromLead.itemsText || "No items were written down"}
                  {fromLead.total > 0 && ` · agreed total ${formatMoney(fromLead.total)}`}
                </div>
                {fromLead.address && (
                  <div className="text-muted-foreground">{fromLead.address}</div>
                )}
              </div>
            )}
          </DialogHeader>
          {!hasProducts ? (
            <p className="px-5 pb-5 text-sm text-muted-foreground">
              Add a product with a variant (and some stock) first.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
                <section className="space-y-3 rounded-xl bg-muted/25 p-3 ring-1 ring-border sm:p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">Order items</h3>
                      <p className="text-xs text-muted-foreground">
                        Product, sale price, quantity, and item discount.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setItems([...items, emptyItem()])}
                    >
                      <Plus />
                      Add item
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {items.map((it, i) => {
                      const selectedVariant = it.variant;
                      const quantity = parseInt(it.quantity) || 0;
                      const itemUpp = uppOf(it);
                      const sellingByPack = !!itemUpp && it.unit === "PACK";
                      // Stock check compares pieces — convert packet quantities.
                      const piecesNeeded = sellingByPack ? quantity * itemUpp! : quantity;
                      const itemTotal =
                        (parseFloat(it.unitPrice) || 0) * quantity - (parseFloat(it.discount) || 0);
                      const stockWarning =
                        selectedVariant && piecesNeeded > selectedVariant.stock
                          ? `Only ${selectedVariant.stock} pcs in stock`
                          : null;

                      return (
                        <div
                          key={i}
                          className="rounded-xl bg-background p-3 ring-1 ring-border transition-shadow focus-within:ring-ring/60 sm:p-4"
                        >
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium">Item {i + 1}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {selectedVariant
                                  ? `${selectedVariant.label} · ${selectedVariant.stock} in stock`
                                  : "Choose a product"}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Remove item ${i + 1}`}
                              disabled={items.length === 1}
                              onClick={() => setItems(items.filter((_, j) => j !== i))}
                            >
                              <Trash2 />
                            </Button>
                          </div>

                          <div className="grid grid-cols-3 gap-3 lg:grid-cols-[minmax(16rem,1fr)_8rem_6rem_8rem]">
                            <div className="col-span-3 space-y-2 lg:col-span-1">
                              <Label>Product</Label>
                              <AsyncCombobox
                                value={it.variant}
                                onChange={(opt) =>
                                  updateItem(i, {
                                    variant: opt,
                                    unit: "PIECE",
                                    unitPrice: prefillPrice(opt, "PIECE"),
                                  })
                                }
                                fetchPage={async (q, cursor) => {
                                  const res = await searchVariants(slug, q, cursor);
                                  return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                                }}
                                placeholder="Search product…"
                                renderItem={(o) => (
                                  <>
                                    <span className="truncate">{o.label}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                      {formatStock(o.stock, o.unitsPerPack)} in stock
                                    </span>
                                  </>
                                )}
                              />
                              {itemUpp && (
                                <Select
                                  value={it.unit}
                                  onValueChange={(v) => {
                                    const unit = (v as ItemDraft["unit"]) ?? "PIECE";
                                    // Re-prefill the price in the new unit (packet
                                    // price = piece price × pack size).
                                    updateItem(i, {
                                      unit,
                                      unitPrice: prefillPrice(it.variant, unit) || it.unitPrice,
                                    });
                                  }}
                                >
                                  <SelectTrigger className="h-8 w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="PIECE">Sell by single piece</SelectItem>
                                    <SelectItem value="PACK">Sell by packet ({itemUpp} pcs)</SelectItem>
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                            <div className="space-y-2">
                              <Label>{sellingByPack ? "Price/pkt" : "Price"}</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                placeholder="0.00"
                                value={it.unitPrice}
                                onChange={(e) => updateItem(i, { unitPrice: e.target.value })}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>{sellingByPack ? "Qty (pkt)" : "Qty"}</Label>
                              <Input
                                type="number"
                                min="1"
                                inputMode="numeric"
                                value={it.quantity}
                                aria-invalid={Boolean(stockWarning)}
                                onChange={(e) => updateItem(i, { quantity: e.target.value })}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Discount</Label>
                              <Input
                                type="number"
                                step="0.01"
                                min="0"
                                inputMode="decimal"
                                placeholder="0.00"
                                value={it.discount}
                                onChange={(e) => updateItem(i, { discount: e.target.value })}
                              />
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <span className={stockWarning ? "text-destructive" : "text-muted-foreground"}>
                              {stockWarning ??
                                (sellingByPack
                                  ? `= ${piecesNeeded} pieces @ ${formatMoney(
                                      (parseFloat(it.unitPrice) || 0) / itemUpp!,
                                    )}/pc`
                                  : "Stock will be validated before saving.")}
                            </span>
                            <span className="font-medium tabular-nums">
                              Line total {formatMoney(Math.max(itemTotal, 0))}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="space-y-3 rounded-xl bg-muted/25 p-3 ring-1 ring-border sm:p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold">Gifts (free items)</h3>
                      <p className="text-xs text-muted-foreground">
                        Not shown on the customer invoice — tracked internally in sales details.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setGifts([...gifts, emptyGift()])}
                    >
                      <Plus />
                      Add gift
                    </Button>
                  </div>

                  {gifts.length > 0 && (
                    <div className="space-y-3">
                      {gifts.map((g, i) => {
                        const qty = parseInt(g.quantity) || 0;
                        const giftStockWarning =
                          g.mode === "PRODUCT" && g.variant && qty > g.variant.stock
                            ? `Only ${g.variant.stock} in stock`
                            : null;
                        return (
                          <div
                            key={i}
                            className="rounded-xl bg-background p-3 ring-1 ring-border transition-shadow focus-within:ring-ring/60 sm:p-4"
                          >
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <p className="text-sm font-medium">Gift {i + 1}</p>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Remove gift ${i + 1}`}
                                onClick={() => setGifts(gifts.filter((_, j) => j !== i))}
                              >
                                <Trash2 />
                              </Button>
                            </div>
                            <div className="grid grid-cols-2 gap-3 lg:grid-cols-[8rem_minmax(14rem,1fr)_6rem_8rem]">
                              <div className="col-span-2 space-y-2 lg:col-span-1">
                                <Label>Type</Label>
                                <Select
                                  value={g.mode}
                                  onValueChange={(v) =>
                                    updateGift(i, { mode: (v as GiftDraft["mode"]) ?? "PRODUCT" })
                                  }
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent align="start">
                                    <SelectItem value="PRODUCT">Product</SelectItem>
                                    <SelectItem value="CUSTOM">Custom</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              {g.mode === "PRODUCT" ? (
                                <div className="col-span-2 space-y-2 lg:col-span-1">
                                  <Label>Product</Label>
                                  <AsyncCombobox
                                    value={g.variant}
                                    onChange={(opt) =>
                                      // Selecting a product auto-fills its latest
                                      // purchase cost; still editable below.
                                      updateGift(i, {
                                        variant: opt,
                                        unitCost: opt ? String(opt.unitCost) : "0",
                                        costEdited: false,
                                      })
                                    }
                                    fetchPage={async (q, cursor) => {
                                      const res = await searchVariants(slug, q, cursor);
                                      return res.ok
                                        ? { items: res.items, next: res.next }
                                        : { items: [], next: null };
                                    }}
                                    placeholder="Search product…"
                                    renderItem={(o) => (
                                      <>
                                        <span className="truncate">{o.label}</span>
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                          {formatStock(o.stock, o.unitsPerPack)} in stock
                                        </span>
                                      </>
                                    )}
                                  />
                                </div>
                              ) : (
                                <div className="col-span-2 space-y-2 lg:col-span-1">
                                  <Label>Gift name</Label>
                                  <Input
                                    placeholder="e.g. Keychain, wrapping…"
                                    value={g.label}
                                    onChange={(e) => updateGift(i, { label: e.target.value })}
                                  />
                                </div>
                              )}
                              <div className="space-y-2">
                                <Label>Qty</Label>
                                <Input
                                  type="number"
                                  min="1"
                                  inputMode="numeric"
                                  value={g.quantity}
                                  aria-invalid={Boolean(giftStockWarning)}
                                  onChange={(e) => updateGift(i, { quantity: e.target.value })}
                                />
                              </div>
                              <div className="space-y-2">
                                <Label>Unit cost</Label>
                                <Input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  inputMode="decimal"
                                  value={g.unitCost}
                                  onChange={(e) =>
                                    updateGift(i, { unitCost: e.target.value, costEdited: true })
                                  }
                                />
                              </div>
                            </div>
                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                              <span
                                className={giftStockWarning ? "text-destructive" : "text-muted-foreground"}
                              >
                                {giftStockWarning ??
                                  (g.mode === "PRODUCT"
                                    ? g.costEdited
                                      ? "Deducts stock; using your custom cost."
                                      : "Deducts stock; cost auto-filled from the latest purchase."
                                    : "No stock effect; cost reduces profit.")}
                              </span>
                              <span className="font-medium tabular-nums">
                                Gift cost{" "}
                                {formatMoney(
                                  (parseFloat(g.unitCost) || 0) * (parseInt(g.quantity) || 0),
                                )}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold">Customer and status</h3>
                    <p className="text-xs text-muted-foreground">
                      Walk-in orders can be saved without a customer profile.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>Customer</Label>
                        <button
                          type="button"
                          onClick={() => setNewCustomerOpen(true)}
                          className="text-xs text-primary underline underline-offset-2 hover:opacity-80"
                        >
                          + New customer
                        </button>
                      </div>
                      <AsyncCombobox
                        value={customer}
                        onChange={chooseCustomer}
                        fetchPage={async (q, cursor) => {
                          const res = await searchCustomers(slug, q, cursor);
                          return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                        }}
                        placeholder="Walk-in — search to attach…"
                        emptyText="No customers"
                      />
                      <ShipFields value={ship} onChange={setShip} />
                    </div>
                    <Field name="date" label="Date" required>
                      <Input id="o-date" name="date" type="date" required defaultValue={todayInputValue()} />
                    </Field>
                    <div className="space-y-2">
                      <Label>Status</Label>
                      <Select value={status} onValueChange={(v) => setStatus(v ?? "PENDING")}>
                        <SelectTrigger className="h-10 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start">
                          {STATUSES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {formatEnum(s)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Held by</Label>
                      <Select
                        value={heldById}
                        onValueChange={(v) => setHeldById(v ?? NONE)}
                        items={[
                          { value: NONE, label: "Not assigned" },
                          ...members.map((m) => ({ value: m.id, label: m.label })),
                        ]}
                      >
                        <SelectTrigger className="h-10 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start">
                          <SelectItem value={NONE}>Not assigned</SelectItem>
                          {members.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </section>

                <section className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-3 rounded-xl bg-muted/20 p-3 ring-1 ring-border sm:p-4">
                    <div>
                      <h3 className="text-sm font-semibold">Delivery</h3>
                      <p className="text-xs text-muted-foreground">
                        Courier cost is used for profit calculation.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Type</Label>
                        <Select value={deliveryType} onValueChange={(v) => setDeliveryType(v ?? "SELF")}>
                          <SelectTrigger className="h-10 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="start">
                            {DELIVERY.map((s) => (
                              <SelectItem key={s} value={s}>
                                {formatEnum(s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Field name="deliveryCharge" label="Charge from customer">
                        <Input
                          id="o-delivery"
                          name="deliveryCharge"
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          value={deliveryCharge}
                          onChange={(e) => setDeliveryCharge(e.target.value)}
                        />
                      </Field>
                      {deliveryType === "COURIER" && couriers.length > 0 && (
                        <>
                          <div className="space-y-2">
                            <Label>Courier</Label>
                            <Select
                              value={courierId}
                              onValueChange={(v) => onCourierChange(v ?? NONE)}
                              items={[
                                { value: NONE, label: "Not set" },
                                ...couriers.map((c) => ({ value: c.id, label: c.name })),
                              ]}
                            >
                              <SelectTrigger className="h-10 w-full">
                                <span data-slot="select-value">
                                  {couriers.find((c) => c.id === courierId)?.name ?? "Not set"}
                                </span>
                              </SelectTrigger>
                              <SelectContent align="start">
                                <SelectItem value={NONE}>Not set</SelectItem>
                                {couriers.map((c) => (
                                  <SelectItem key={c.id} value={c.id}>
                                    {c.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label>Zone</Label>
                            <Select
                              value={courierZoneId}
                              onValueChange={(v) => setCourierZoneId(v ?? NONE)}
                              items={[
                                { value: NONE, label: "Not set" },
                                ...(selectedCourier?.zones ?? []).map((z) => ({
                                  value: z.id,
                                  label: `${z.name} · ${z.rate.toFixed(0)}`,
                                })),
                              ]}
                            >
                              <SelectTrigger className="h-10 w-full">
                                <span data-slot="select-value">
                                  {selectedCourier?.zones.find((z) => z.id === courierZoneId)?.name ??
                                    "Not set"}
                                </span>
                              </SelectTrigger>
                              <SelectContent align="start">
                                <SelectItem value={NONE}>Not set</SelectItem>
                                {(selectedCourier?.zones ?? []).map((z) => (
                                  <SelectItem key={z.id} value={z.id}>
                                    {z.name} · {z.rate.toFixed(0)}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="o-weight">Weight (kg)</Label>
                            <Input
                              id="o-weight"
                              name="weightKg"
                              type="number"
                              step="0.01"
                              min="0"
                              inputMode="decimal"
                              placeholder={suggestedWeightKg ? String(suggestedWeightKg) : "0.5"}
                              value={weightKg}
                              onChange={(e) => setWeightKg(e.target.value)}
                            />
                            {suggestedWeightKg !== null && !weightKg && (
                              <p className="text-xs text-muted-foreground">
                                ~{suggestedWeightKg}kg from the items&apos; own weights.
                              </p>
                            )}
                          </div>
                          <input type="hidden" name="courierId" value={courierId === NONE ? "" : courierId} />
                          <input
                            type="hidden"
                            name="courierZoneId"
                            value={courierZoneId === NONE ? "" : courierZoneId}
                          />
                          <div className="space-y-2">
                            <Label htmlFor="o-delivery-cost">Actual courier cost</Label>
                            <Input
                              id="o-delivery-cost"
                              name="deliveryCost"
                              type="number"
                              step="0.01"
                              min="0"
                              inputMode="decimal"
                              placeholder={
                                courierQuote ? String(courierQuote.deliveryCharge) : "Same as charge"
                              }
                              value={deliveryCost}
                              onChange={(e) => setDeliveryCost(e.target.value)}
                            />
                            <p className="text-xs text-muted-foreground">
                              Blank uses the rate above. Type only for a one-off price.
                            </p>
                          </div>
                          {/* The percentage fee is the part that gets forgotten, so
                              the real cost is spelled out next to the charge being
                              set — not discovered at the end of the month. */}
                          {courierQuote && (
                            <div className="sm:col-span-2">
                              <p
                                className={cn(
                                  "rounded-md border p-3 text-sm",
                                  deliveryShortfall > 0
                                    ? "border-destructive/40 bg-destructive/5"
                                    : "bg-muted/40",
                                )}
                              >
                                Courier keeps{" "}
                                <span className="font-medium tabular-nums">
                                  <Money value={courierQuote.total} />
                                </span>{" "}
                                — <Money value={courierQuote.deliveryCharge} /> delivery
                                {courierQuote.weightCharge > 0 &&
                                  ` (incl. ${formatMoney(courierQuote.weightCharge)} weight)`}{" "}
                                + <Money value={courierQuote.codFee} /> COD fee.
                                {deliveryShortfall > 0 ? (
                                  <>
                                    {" "}
                                    You&apos;re charging{" "}
                                    <span className="font-medium tabular-nums">
                                      <Money value={deliveryShortfall} />
                                    </span>{" "}
                                    too little
                                    {breakEven !== null && (
                                      <> — <Money value={breakEven} /> breaks even</>
                                    )}
                                    .
                                  </>
                                ) : (
                                  " Covered by what you're charging."
                                )}
                              </p>
                            </div>
                          )}
                          <div className="space-y-2 sm:col-span-2">
                            <Label htmlFor="o-courier-tracking">Courier order number</Label>
                            <Input
                              id="o-courier-tracking"
                              name="courierTrackingId"
                              placeholder="Leave blank if not known yet — add it later from the list"
                            />
                          </div>
                        </>
                      )}
                      {/* No couriers set up yet: the old two-number form, plus a
                          way out of it. Nothing breaks by ignoring the rules —
                          the cost is just typed, as it always was. */}
                      {deliveryType === "COURIER" && couriers.length === 0 && (
                        <>
                          <div className="space-y-2 sm:col-span-2">
                            <Label htmlFor="o-delivery-cost">Actual courier cost</Label>
                            <Input
                              id="o-delivery-cost"
                              name="deliveryCost"
                              type="number"
                              step="0.01"
                              min="0"
                              inputMode="decimal"
                              placeholder="Same as delivery charge if blank"
                              value={deliveryCost}
                              onChange={(e) => setDeliveryCost(e.target.value)}
                            />
                            <p className="text-xs text-muted-foreground">
                              <Link
                                href={`/${slug}/settings/couriers`}
                                className="underline underline-offset-2"
                              >
                                Set up your courier&apos;s rates
                              </Link>{" "}
                              and this fills itself in — including the COD fee, which this
                              number leaves out.
                            </p>
                          </div>
                          <div className="space-y-2 sm:col-span-2">
                            <Label htmlFor="o-courier-tracking2">Courier order number</Label>
                            <Input
                              id="o-courier-tracking2"
                              name="courierTrackingId"
                              placeholder="Leave blank if not known yet — add it later from the list"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="space-y-3 rounded-xl bg-muted/20 p-3 ring-1 ring-border sm:p-4">
                    <div>
                      <h3 className="text-sm font-semibold">Payment and costs</h3>
                      <p className="text-xs text-muted-foreground">
                        Internal costs reduce profit, not customer total.
                      </p>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Payment method</Label>
                        <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v ?? "CASH")}>
                          <SelectTrigger className="h-10 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="start">
                            {METHODS.map((s) => (
                              <SelectItem key={s} value={s}>
                                {formatEnum(s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Payment status</Label>
                        <Select value={paymentStatus} onValueChange={(v) => setPaymentStatus(v ?? "UNPAID")}>
                          <SelectTrigger className="h-10 w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="start">
                            {PAY_STATUS.map((s) => (
                              <SelectItem key={s} value={s}>
                                {formatEnum(s)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {/* PARTIAL without a figure is just a word: the whole
                          order stays on the due list and the advance is money
                          the app has never heard of. */}
                      {paymentStatus === "PARTIAL" && (
                        <div className="space-y-2">
                          <Label htmlFor="o-paid">Paid so far</Label>
                          <MoneyInput
                            id="o-paid"
                            name="amountPaid"
                            min="0"
                            required
                            value={amountPaid}
                            onChange={(e) => setAmountPaid(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            Still due{" "}
                            <Money
                              value={Math.max(
                                0,
                                preview.customerTotal - (parseFloat(amountPaid) || 0),
                              )}
                            />
                          </p>
                        </div>
                      )}
                      <PackagingCostField
                        id="o-pack"
                        value={packagingCost}
                        onChange={setPackagingCost}
                      />
                      <div className="space-y-2">
                        <Label htmlFor="o-disc">Order discount</Label>
                        <Input
                          id="o-disc"
                          name="discount"
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          value={orderDiscount}
                          onChange={(e) => setOrderDiscount(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <Field name="notes" label="Notes">
                  <Textarea
                    id="o-notes"
                    name="notes"
                    className="min-h-20"
                    placeholder="Courier note, payment note, or special instruction"
                  />
                </Field>
              </div>

              <div className="shrink-0 border-t bg-background/95 p-4 backdrop-blur">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="grid w-full grid-cols-2 gap-x-4 gap-y-1 text-sm sm:max-w-md">
                    <span className="text-muted-foreground">Items</span>
                    <span className="text-right font-medium tabular-nums">
                      {formatMoney(preview.itemsSubtotal)}
                    </span>
                    <span className="text-muted-foreground">Order total</span>
                    <span className="text-right text-base font-semibold tabular-nums">
                      {formatMoney(Math.max(preview.customerTotal, 0))}
                    </span>
                    {preview.costPreview > 0 && (
                      <>
                        <span className="text-muted-foreground">Cost preview</span>
                        <span className="text-right tabular-nums">
                          {formatMoney(preview.costPreview)}
                        </span>
                      </>
                    )}
                  </div>
                  <Button type="submit" className="w-full sm:w-auto" disabled={loading}>
                    {loading ? "Saving…" : "Create order"}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Inline new-customer dialog — quick create + auto-select on the order */}
      <Dialog open={newCustomerOpen} onOpenChange={setNewCustomerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New customer</DialogTitle>
          </DialogHeader>
          <form onSubmit={onCreateCustomer} className="space-y-4">
            <Field name="name" label="Name" required>
              <Input id="nc-name" name="name" required autoFocus />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field name="phone" label="Phone">
                <Input id="nc-phone" name="phone" />
              </Field>
              <Field name="altPhone" label="Alt phone">
                <Input id="nc-alt-phone" name="altPhone" />
              </Field>
            </div>
            <Field name="address" label="Address">
              <Input id="nc-address" name="address" />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={newCustomerSaving}>
                {newCustomerSaving ? "Saving…" : "Add & select"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Cancellation — what it cost, asked once, while it's still known. */}
      <Dialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)}>
        {/* Three money fields side by side need the room — at sm:max-w-sm the
            labels wrap onto two lines and the row reads as six controls. */}
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Cancel this order?</DialogTitle>
          </DialogHeader>
          {cancelling && (
            <form key={cancelling.id} onSubmit={onConfirmCancel} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {cancelling.customerName}&apos;s order goes back into stock and stops
                counting as a sale. Anything it already cost is recorded below and
                comes off profit — leave a field at 0 if it never happened.
              </p>

              {/* Only a PAID order that reached the treasury needs this: the
                  money is sitting in the box against a sale that no longer
                  exists, and nothing here can guess whether it was refunded. */}
              {cancelling.cashInTreasury && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-300">
                  This order&apos;s cash is marked deposited in the treasury. If you
                  refund the customer, undo &quot;cash deposited&quot; on this order too
                  — cancelling here does not touch the treasury.
                </p>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="cx-delivery">Courier return charge</Label>
                  <Input
                    id="cx-delivery"
                    name="deliveryCost"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={cancelling.deliveryCost ?? 0}
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    What the courier charged to bring it back.
                  </p>
                </div>
                <PackagingCostField
                  id="cx-packaging"
                  value={cancelPackaging}
                  onChange={setCancelPackaging}
                  hint="0 if never packed."
                />
                <div className="space-y-2">
                  <Label htmlFor="cx-gift">Gift cost</Label>
                  <Input
                    id="cx-gift"
                    name="giftCost"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={cancelling.giftCost}
                  />
                  <p className="text-xs text-muted-foreground">0 if it came back.</p>
                </div>
              </div>

              {/* A partial delivery still collects money — the customer keeps
                  nothing but pays the shipping. Without this the cancellation
                  reads as a total loss when it was nearly break-even. */}
              <div className="space-y-2">
                <Label htmlFor="cx-collected">Collected from the customer anyway</Label>
                <Input
                  id="cx-collected"
                  name="cancelledCollected"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={0}
                />
                <p className="text-xs text-muted-foreground">
                  Partial delivery — they paid the delivery and sent the goods back. 0 if
                  nothing was collected.
                </p>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCancelling(null)}
                  disabled={cancelSaving}
                >
                  Keep the order
                </Button>
                <Button type="submit" variant="destructive" disabled={cancelSaving}>
                  {cancelSaving ? "Cancelling…" : "Cancel the order"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Partial-payment dialog. PARTIAL used to be a status with no figure
          behind it, so a 3,000 advance on a 5,000 order left the app chasing
          the whole 5,000 and holding the 3,000 nowhere at all. */}
      <Dialog open={!!partPaying} onOpenChange={(o) => !o && setPartPaying(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>How much has been paid?</DialogTitle>
          </DialogHeader>
          {partPaying && (
            <form key={partPaying.id} onSubmit={onConfirmPartial} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {partPaying.customerName}&apos;s order comes to{" "}
                <Money value={partPaying.totals.customerTotal} />. Enter what they have
                handed over so far — the rest stays on the due list.
              </p>
              <Field
                name="amountPaid"
                label="Paid so far"
                required
                hint={`Order total ${formatMoney(partPaying.totals.customerTotal)}`}
              >
                <MoneyInput
                  min="0"
                  required
                  autoFocus
                  value={partPaidAmount}
                  onChange={(e) => setPartPaidAmount(e.target.value)}
                />
              </Field>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Still due{" "}
                  <Money
                    value={Math.max(
                      0,
                      partPaying.totals.customerTotal - (parseFloat(partPaidAmount) || 0),
                    )}
                  />
                </p>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPartPaying(null)}
                  disabled={partPaySaving}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={partPaySaving}>
                  {partPaySaving ? "Saving…" : "Record payment"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Return dialog */}
      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a return</DialogTitle>
          </DialogHeader>
          {returnOrder && returnOrder.items.some((it) => it.remaining > 0) ? (
            <form onSubmit={onSubmitReturn} className="space-y-4">
              <div className="space-y-2">
                <Label>Item</Label>
                <Select
                  value={returnItemId}
                  onValueChange={(v) => setReturnItemId(v ?? "")}
                  items={returnOrder.items
                    .filter((it) => it.remaining > 0)
                    .map((it) => ({ value: it.id, label: `${it.label} · ${it.remaining} returnable` }))}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select item" />
                  </SelectTrigger>
                  <SelectContent>
                    {returnOrder.items
                      .filter((it) => it.remaining > 0)
                      .map((it) => (
                        <SelectItem key={it.id} value={it.id}>
                          {it.label} · {it.remaining} returnable
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="r-qty">Quantity</Label>
                  <Input id="r-qty" name="quantity" type="number" min="1" required defaultValue="1" />
                </div>
                <Field name="refundAmount" label="Refund amount">
                  <Input id="r-refund" name="refundAmount" type="number" step="0.01" min="0" defaultValue="0" />
                </Field>
              </div>
              <Field name="reason" label="Reason">
                <Input id="r-reason" name="reason" />
              </Field>
              <DialogFooter>
                <Button type="submit">Record return</Button>
              </DialogFooter>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing left to return on this order.</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit details dialog — header/money fields only; items and status have
          their own flows (stock and returns hang off items). */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit order details</DialogTitle>
          </DialogHeader>
          {editOrder && (
            <form key={editOrder.id} onSubmit={onSubmitEdit} className="space-y-4">
              <div className="space-y-2">
                <Label>Customer</Label>
                <AsyncCombobox
                  value={editCustomer}
                  onChange={async (opt) => {
                    setEditCustomer(opt);
                    if (!opt) return;
                    const c = await customerContact(slug, opt.value);
                    if (c) {
                      setEditShip({
                        name: c.name,
                        phone: c.phone ?? "",
                        address: c.address ?? "",
                      });
                    }
                  }}
                  fetchPage={async (q, cursor) => {
                    const res = await searchCustomers(slug, q, cursor);
                    return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                  }}
                  placeholder="Walk-in — search to attach…"
                  emptyText="No customers"
                />
                <ShipFields value={editShip} onChange={setEditShip} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field name="date" label="Date" required>
                  <Input id="eo-date" name="date" type="date" required defaultValue={editOrder.date} />
                </Field>
                <div className="space-y-2">
                  <Label>Delivery type</Label>
                  <Select value={editDeliveryType} onValueChange={(v) => setEditDeliveryType(v ?? "SELF")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SELF">SELF</SelectItem>
                      <SelectItem value="COURIER">COURIER</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field name="deliveryCharge" label="Delivery charge (customer pays)" required>
                  <Input
                    id="eo-charge"
                    name="deliveryCharge"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={editOrder.deliveryCharge}
                  />
                </Field>
                <Field name="deliveryCost" label="Courier cost (actual)">
                  <Input
                    id="eo-cost"
                    name="deliveryCost"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={
                      editCourierQuote
                        ? String(editCourierQuote.deliveryCharge)
                        : "blank = same as charge"
                    }
                    defaultValue={editOrder.deliveryCost ?? ""}
                  />
                </Field>
              </div>

              {/* Courier, zone and weight are editable here so an order that
                  predates its courier's rules — or one sent on the wrong zone
                  — can be corrected where everything else about it is. */}
              {editDeliveryType === "COURIER" && couriers.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Courier</Label>
                    <Select
                      value={editCourierId}
                      onValueChange={(v) => {
                        setEditCourierId(v ?? NONE);
                        setEditCourierZoneId(NONE);
                      }}
                      items={[
                        { value: NONE, label: "Not set" },
                        ...couriers.map((c) => ({ value: c.id, label: c.name })),
                      ]}
                    >
                      <SelectTrigger className="w-full">
                        <span data-slot="select-value">
                          {couriers.find((c) => c.id === editCourierId)?.name ?? "Not set"}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not set</SelectItem>
                        {couriers.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Zone</Label>
                    <Select
                      value={editCourierZoneId}
                      onValueChange={(v) => setEditCourierZoneId(v ?? NONE)}
                      items={[
                        { value: NONE, label: "Not set" },
                        ...(editCourier?.zones ?? []).map((z) => ({
                          value: z.id,
                          label: `${z.name} · ${z.rate.toFixed(0)}`,
                        })),
                      ]}
                    >
                      <SelectTrigger className="w-full">
                        <span data-slot="select-value">
                          {editCourier?.zones.find((z) => z.id === editCourierZoneId)?.name ??
                            "Not set"}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not set</SelectItem>
                        {(editCourier?.zones ?? []).map((z) => (
                          <SelectItem key={z.id} value={z.id}>
                            {z.name} · {z.rate.toFixed(0)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Field name="weightKg" label="Weight (kg)">
                    <Input
                      id="eo-weight"
                      name="weightKg"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.5"
                      value={editWeightKg}
                      onChange={(e) => setEditWeightKg(e.target.value)}
                    />
                  </Field>
                  <input
                    type="hidden"
                    name="courierId"
                    value={editCourierId === NONE ? "" : editCourierId}
                  />
                  <input
                    type="hidden"
                    name="courierZoneId"
                    value={editCourierZoneId === NONE ? "" : editCourierZoneId}
                  />
                  {editCourierQuote && (
                    <p className="rounded-md border bg-muted/40 p-3 text-sm sm:col-span-3">
                      Courier keeps{" "}
                      <span className="font-medium tabular-nums">
                        <Money value={editCourierQuote.total} />
                      </span>{" "}
                      — <Money value={editCourierQuote.deliveryCharge} /> delivery +{" "}
                      <Money value={editCourierQuote.codFee} /> COD fee. Saving recalculates it
                      from these rates.
                    </p>
                  )}
                </div>
              )}

              {/* Cash changes hands, and until now this could only be set
                  when the order was created — a wrong name stayed wrong. */}
              <div className="space-y-2">
                <Label>Cash held by</Label>
                <Select
                  value={editHeldById}
                  onValueChange={(v) => setEditHeldById(v ?? NONE)}
                  items={[
                    { value: NONE, label: "Nobody assigned" },
                    ...members.map((m) => ({ value: m.id, label: m.label })),
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <span data-slot="select-value">
                      {members.find((m) => m.id === editHeldById)?.label ?? "Nobody assigned"}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Nobody assigned</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Only on a cancelled order, and only because a partial
                  delivery still hands money over — the one number the cancel
                  dialog asks for that nothing else can recover. */}
              {editOrder.status === "CANCELLED" && (
                <Field name="cancelledCollected" label="Collected on a partial delivery">
                  <Input
                    id="eo-collected"
                    name="cancelledCollected"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={editOrder.cancelledCollected}
                  />
                </Field>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Payment method</Label>
                  <Select value={editPaymentMethod} onValueChange={(v) => setEditPaymentMethod(v ?? "CASH")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METHODS.map((m) => (
                        <SelectItem key={m} value={m}>
                          {formatEnum(m)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Field name="discount" label="Order discount" required>
                  <Input
                    id="eo-discount"
                    name="discount"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={editOrder.discount}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <PackagingCostField
                  id="eo-packaging"
                  value={editPackaging}
                  onChange={setEditPackaging}
                  required
                />
                <div className="space-y-2">
                  <Label htmlFor="eo-gift">Gift cost</Label>
                  <Input
                    id="eo-gift"
                    name="giftCost"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue={editOrder.giftCost}
                    // An order with gift lines gets its total from them on save,
                    // whatever is typed here — so it isn't editable, rather than
                    // accepting a number it will then ignore.
                    readOnly={editOrder.gifts.length > 0}
                    className={editOrder.gifts.length > 0 ? "text-muted-foreground" : undefined}
                  />
                  {editOrder.gifts.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      Added up from this order&apos;s {editOrder.gifts.length} gift line(s).
                    </p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="eo-notes">Notes</Label>
                <Textarea id="eo-notes" name="notes" defaultValue={editOrder.notes ?? ""} />
              </div>
              <p className="text-xs text-muted-foreground">
                Items, status, payment status and courier ID are edited from their own controls.
                If this order&apos;s cash is already in the treasury, that entry re-syncs
                automatically.
              </p>
              <DialogFooter>
                <Button type="submit" disabled={editSaving}>
                  {editSaving ? "Saving…" : "Save changes"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The delivery block: who this parcel goes to and where.
 *
 * Prefilled from the selected customer and then left alone. Only what actually
 * differs from their record is stored on the order (see shipSnapshot in
 * server/actions/orders), so an untouched block costs nothing and a corrected
 * customer record still reaches every document that had nothing else to say.
 */
function ShipFields({
  value,
  onChange,
}: {
  value: { name: string; phone: string; address: string };
  onChange: (v: { name: string; phone: string; address: string }) => void;
}) {
  return (
    <div className="mt-3 space-y-2 rounded-md border border-dashed p-3">
      <div className="text-xs font-medium text-muted-foreground">
        Deliver to — printed on the invoice and the order form
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          name="shipName"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          placeholder="Name"
          aria-label="Delivery name"
        />
        <Input
          name="shipPhone"
          value={value.phone}
          onChange={(e) => onChange({ ...value, phone: e.target.value })}
          placeholder="Phone"
          aria-label="Delivery phone"
        />
      </div>
      <Textarea
        name="shipAddress"
        rows={2}
        value={value.address}
        onChange={(e) => onChange({ ...value, address: e.target.value })}
        placeholder="Full address"
        aria-label="Delivery address"
      />
    </div>
  );
}
