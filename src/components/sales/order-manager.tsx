"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  createOrder,
  updateOrderStatus,
  updateOrderHeader,
  recordPayment,
  updatePaymentStatus,
  refreshCourierStatuses,
  updateCourierTrackingId,
  createReturn,
  deleteOrder,
  setOrderSource,
} from "@/server/actions/orders";
import { linkLeadToOrder } from "@/server/actions/leads";
import type { ComboOptionForOrder } from "@/server/actions/combos";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  COURIER_STATUSES,
  COURIER_STATUS_LABEL,
  COURIER_STATUS_TONE,
  NO_COURIER_STATUS,
} from "@/lib/courier-status";
import { OrderSourceCell } from "@/components/sales/order-source-cell";
import { OrderCampaignCell, type CampaignOption } from "@/components/sales/order-campaign-cell";
import { ParcelBookingDialog } from "@/components/sales/parcel-booking-dialog";
import { quoteCourier, breakEvenDeliveryCharge, type CourierRules } from "@/lib/courier";
import { Columns3, Plus, Printer, Send, ShoppingCart, Trash2, MoreVertical, X } from "lucide-react";
import { formatStock } from "@/lib/units";
import { cn } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { Stamp } from "@/components/ui/stamp";
import { toDhakaInputValue, type DhakaStamp } from "@/lib/dhaka-time";
import { formatMoney, round2 } from "@/lib/money";
import { stockShortfall } from "@/lib/combos";
import { goodsLikelyWithCourier, OVERDUE_RETURN_DAYS } from "@/lib/returns";
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
type OrderRow = DhakaStamp & {
  id: string;
  /**
   * The short per-workspace number, not the cuid — the figure a courier's
   * statement and Steadfast's own app carry. Null on rows that predate the
   * backfill; nothing assigns one retroactively.
   */
  orderNo: number | null;
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
  /** Where a cancelled order's goods are: NONE | IN_TRANSIT | RECEIVED | LOST. */
  returnLeg: string;
  /** When the leg last moved, already formatted. Null before it ever moved. */
  returnLegOn: string | null;
  /** Days since then — how overdue a parcel still in transit is. */
  returnLegDays: number;
  deliveryType: string;
  courierTrackingId: string | null;
  /** What the courier last said about the parcel — not the order's own status. */
  courierStatus: string | null;
  paymentStatus: string;
  /** Only meaningful while paymentStatus is PARTIAL. */
  amountPaid: number;
  /** Customer total less whatever has been paid towards it. */
  amountDue: number;
  paymentMethod: string;
  source: string | null;
  boostCampaignId: string | null;
  /** Name of the tagged campaign, kept even after it drops off the pick list. */
  boostCampaignName: string | null;
  /** True once this PAID order's cash was marked deposited in the treasury. */
  cashInTreasury: boolean;
  /** The goods were given away — the customer paid nothing for them. */
  isGiveaway: boolean;
  deliveryCharge: number;
  deliveryCost: number | null;
  courierId: string | null;
  courierZoneId: string | null;
  weightKg: number | null;
  cancelledCollected: number;
  /** What the courier's ledger came up short of the invoice. 0 on almost every order. */
  collectionShortfall: number;
  /** Why it came up short, as typed on the courier balance page. */
  collectionNote: string | null;
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

/**
 * Where a cancelled order's goods are, said in the row.
 *
 * Cancelled used to mean one thing and now covers three: the pieces are back
 * on the shelf, or in a van somewhere, or gone for good. Without this the list
 * shows the same red "CANCELLED" for all three, and the only way to tell them
 * apart is to open the order's history one at a time.
 *
 * Nothing is drawn for NONE — the ordinary cancellation, where the goods never
 * left — because a badge on every cancelled row saying "nothing happened" is
 * noise on the busiest list in the app.
 */
function ReturnLegBadge({ order }: { order: OrderRow }) {
  if (order.status !== "CANCELLED" || order.returnLeg === "NONE") return null;
  if (order.returnLeg === "IN_TRANSIT") {
    const overdue = order.returnLegDays >= OVERDUE_RETURN_DAYS;
    return (
      <Badge
        variant="outline"
        className={cn(
          "font-normal",
          overdue
            ? "border-destructive/60 text-destructive"
            : "border-amber-500/60 text-amber-700 dark:text-amber-400",
        )}
        title={
          overdue
            ? "Overdue — worth asking the courier where this parcel is"
            : "With the courier. These pieces stay out of stock until you mark them received."
        }
      >
        Coming back · {order.returnLegDays}d
      </Badge>
    );
  }
  if (order.returnLeg === "RECEIVED") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/60 font-normal text-emerald-700 dark:text-emerald-400"
        title="The goods are back in the shop and on the shelf"
      >
        Back{order.returnLegOn ? ` ${order.returnLegOn}` : ""}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-destructive/60 font-normal text-destructive"
      title="Written off — the courier never brought this parcel back"
    >
      Never came{order.returnLegOn ? ` · ${order.returnLegOn}` : ""}
    </Badge>
  );
}


type Perms = { canAdd: boolean; canEdit: boolean; canViewProfit: boolean };
/** A courier's rules plus its zones — everything quoteCourier needs. */
export type CourierOption = CourierRules & {
  id: string;
  name: string;
  isDefault: boolean;
  /** True when this courier has API credentials stored, so parcels can be booked. */
  apiConnected: boolean;
  zones: { id: string; name: string; rate: number; bands: { uptoKg: number; rate: number }[] }[];
};
/** A call-list row the sales page was sent here to turn into an order. */
export type FromLead = {
  leadId: string;
  customerId: string | null;
  customerName: string;
  phone: string;
  /** What the caller wrote down — free text, so it's shown, not auto-added. */
  itemsText: string;
  /**
   * Combos the website order bought, already matched to this shop's recipes.
   *
   * These ARE added automatically, unlike the free-text items: a combo is
   * matched by product id rather than by name, so there is nothing being
   * guessed at, and its whole component list comes with it.
   */
  combos: { comboSetId: string; quantity: number }[];
  /** The lead's channel, prefilled onto the order's "came from". */
  channel: string | null;
  /** What the caller agreed for shipping, prefilled onto the order. */
  deliveryCharge: number;
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

// Toggleable columns on the orders table (Columns menu). All start hidden —
// the table has to fit a laptop screen without scrolling sideways, and each of
// these is a question asked occasionally rather than read down the list.
//
// Profit used to start on. It is the widest optional column and the one least
// often needed while working the list (the reports page is where margins get
// read), so it pays for itself least — and it is the figure you least want on
// screen when the laptop is turned towards a customer or a courier.
//
// Every optional column belongs here, including ones only some workspaces can
// use (see availability below). Marking a column `hideable` on the DataTable
// instead would work, but it switches on DataTable's OWN Columns menu — and
// this page keeps its own toolbar, so the table would grow a second Columns
// button beside the first.
const OPTIONAL_COLUMNS = [
  { key: "orderId", label: "Order ID" },
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
 * How a combo reads in the picker.
 *
 * Shared by the option list and the `items` map behind the closed trigger, so
 * the two cannot drift into describing the same combo differently.
 */
function comboLabel(c: ComboOptionForOrder): string {
  return `${c.name} · ${formatMoney(c.price)}${c.buildable === 0 ? " · none left" : ""}`;
}

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
  return String(round2(perUnit));
}

/** Units-per-pack for a draft's selected variant, or null when not pack-based. */
function uppOf(it: { variant: SearchVariantOption | null }): number | null {
  const v = it.variant;
  return v?.unitsPerPack && v.unitsPerPack > 1 ? v.unitsPerPack : null;
}

function emptyGift(): GiftDraft {
  return { mode: "PRODUCT", variant: null, label: "", quantity: "1", unitCost: "0", costEdited: false };
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
/**
 * Which courier statuses have an unambiguous order status behind them.
 *
 * partial_delivered is deliberately absent. It means the customer took some of
 * the parcel and paid for that much — which of DELIVERED or CANCELLED that is
 * depends on figures only the person holding the courier's statement has.
 * Offering a one-click answer would be inventing one.
 */
const COURIER_STATUS_APPLIES: Record<string, string> = {
  delivered: "DELIVERED",
  cancelled: "CANCELLED",
};

function CourierIdCell({
  slug,
  orderId,
  value,
  courierStatus,
  orderStatus,
  canBook,
  canEdit,
  onApplyStatus,
}: {
  slug: string;
  orderId: string;
  value: string | null;
  courierStatus: string | null;
  orderStatus: string;
  /** The order's courier has an API key, and nothing is booked yet. */
  canBook: boolean;
  canEdit: boolean;
  /** The list's own status handler — cancelling still asks what it cost. */
  onApplyStatus: (orderId: string, status: string) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [booking, setBooking] = useState(false);
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

  // What the courier last said, under the id it said it about. Shown rather
  // than applied: moving the order's own status consumes stock and re-quotes
  // the COD fee, and cancelling needs figures the courier never sends. So the
  // webhook writes the badge and a person presses Apply — which routes through
  // the list's normal status handler, so a cancellation still asks what it cost.
  const applies = courierStatus ? COURIER_STATUS_APPLIES[courierStatus] : undefined;
  const statusLine = courierStatus ? (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "text-xs whitespace-nowrap",
          COURIER_STATUS_TONE[courierStatus] ?? "text-muted-foreground",
        )}
      >
        {/* Falls back to the raw value prettified: a status Steadfast adds
            later should show up as itself rather than disappear. */}
        {COURIER_STATUS_LABEL[courierStatus] ?? formatEnum(courierStatus)}
      </span>
      {canEdit && applies && applies !== orderStatus && (
        <button
          type="button"
          onClick={() => onApplyStatus(orderId, applies)}
          className="text-xs text-primary underline-offset-4 hover:underline"
        >
          apply
        </button>
      )}
    </span>
  ) : null;

  if (!canEdit) {
    return (
      <span>
        {value ?? "—"}
        {statusLine}
      </span>
    );
  }

  if (!editing) {
    return (
      <div className="space-y-0.5">
        {value ? (
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            className="text-left underline-offset-4 hover:underline"
          >
            {value}
          </button>
        ) : canBook ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setBooking(true)}>
              <Send className="size-3.5" /> Send to courier
            </Button>
            {/* Booking through the API is the common path, but not the only
                one: a parcel entered by hand in the courier's own app already
                has its consignment number, and offering only "Send to courier"
                left the one thing to do with that number — type it in — with
                nowhere to go, and invited a second booking of a parcel the
                courier already has. */}
            <button
              type="button"
              onClick={() => {
                setDraft("");
                setEditing(true);
              }}
              className="block text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Already sent — add ID
            </button>
            <ParcelBookingDialog
              slug={slug}
              orderId={orderId}
              open={booking}
              onOpenChange={setBooking}
            />
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setEditing(true);
            }}
            className="text-left text-muted-foreground underline-offset-4 hover:underline"
          >
            Add courier ID
          </button>
        )}
        {statusLine}
      </div>
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
  combos,
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
   * Combos on offer right now, already priced and counted. Empty when the shop
   * sells none, and the whole section then stays off the form.
   */
  combos: ComboOptionForOrder[];
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
  // Controlled rather than a defaultValue: the value moves with the clock, and a
  // defaultValue that changes under an uncontrolled input is exactly what Base
  // UI warns about.
  const [orderDate, setOrderDate] = useState(() => toDhakaInputValue(new Date()));
  // The goods are a gift. The discount that makes them free is worked out on the
  // server (see goodsDiscount), so this is a decision, not an arithmetic task.
  const [giveaway, setGiveaway] = useState(false);
  const [editGiveaway, setEditGiveaway] = useState(false);
  /** Cancelled orders only: whether the goods are still travelling back. */
  const [editInTransit, setEditInTransit] = useState(false);
  const [loading, setLoading] = useState(false);
  // The order awaiting a "what did this cancellation cost?" answer.
  const [cancelling, setCancelling] = useState<OrderRow | null>(null);
  // Both dialogs used defaultValue before. The warning has to react as you
  // type, so the value is state now — seeded whenever the dialog opens.
  const [cancelPackaging, setCancelPackaging] = useState("0");
  // Whether the goods are still with the courier. Seeded from the order when
  // the dialog opens (see goodsLikelyWithCourier) and then whatever the person
  // says — they know whether the rider handed the parcel back at the door.
  const [cancelInTransit, setCancelInTransit] = useState(false);
  const [cancelSaving, setCancelSaving] = useState(false);
  // The order awaiting a "how much of it have they paid?" answer. PARTIAL is
  // the one status that means nothing without a number attached.
  const [partPaying, setPartPaying] = useState<OrderRow | null>(null);
  const [partPaidAmount, setPartPaidAmount] = useState("");
  // "add" is a fresh instalment — what the customer just handed over. "correct"
  // rewrites the running total, for the far rarer case of a figure typed wrong.
  // Both used to be the same box asking for the total, which meant every
  // instalment after the first was mental arithmetic done under pressure.
  const [partMode, setPartMode] = useState<"add" | "correct">("add");
  const [partPaySaving, setPartPaySaving] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  /**
   * Combos on this order, as sets.
   *
   * Deliberately NOT expanded into `items` here. The price a combo's
   * components end up carrying is the shop's arithmetic, and doing it in the
   * browser would mean two implementations of it — one here and one on the
   * server, which is the only one that counts. So the form sends "two Flight
   * Starter Combos" and the server writes the lines.
   */
  const [comboPicks, setComboPicks] = useState<{ comboSetId: string; quantity: string }[]>([]);
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
  /** The customer has posted it and it isn't here yet — see Return.receivedAt. */
  const [returnInTransit, setReturnInTransit] = useState(false);

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
  // Courier ID rides along by default once a courier can actually be booked
  // through: the column stopped being a place to read a number and became the
  // place the "Send to courier" button lives. Left off, the feature is behind
  // a menu that forgets — column choices are useState, so a reload puts it
  // back — and every parcel would start with three clicks nobody asked for.
  // Shops that book by hand see the list exactly as they did before.
  const [visibleCols, setVisibleCols] = useState<Set<string>>(() =>
    new Set(couriers.some((c) => c.apiConnected) ? ["courier"] : []),
  );
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
    // What the courier says, as its own question: "which parcels are still out"
    // and "which came back" are asked of the courier's answer, not of the order
    // status — the order sits at Shipped through all of them.
    {
      key: "courier",
      label: "Courier says",
      kind: "select",
      options: [
        { value: NO_COURIER_STATUS, label: "Nothing from the courier" },
        ...COURIER_STATUSES.map((s) => ({ value: s, label: COURIER_STATUS_LABEL[s] ?? s })),
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
    {
      key: "free",
      label: "Free orders",
      kind: "select",
      options: [{ value: "__yes__", label: "Given away free" }],
    },
    // The one question the status filter can't answer: of everything cancelled,
    // which parcels are actually back in the shop. Cancelled is one status and
    // three quite different situations.
    {
      key: "goods",
      label: "Cancelled goods",
      kind: "select",
      options: [
        { value: "IN_TRANSIT", label: "Coming back" },
        { value: "RECEIVED", label: "Received back" },
        { value: "LOST", label: "Never came back" },
      ],
    },
    { key: "date", label: "Order date", kind: "dateRange" },
  ];
  const BAR_TO_URL: Record<string, string> = {
    source: "source",
    delivery: "delivery",
    courier: "courier",
    held: "held",
    free: "free",
    goods: "goods",
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
    // Tags outlive the pick list: once every campaign has finished there is
    // nothing left to offer, but the orders they brought in still say so.
    if (c.key === "campaign")
      return campaigns.length > 0 || orders.some((o) => o.boostCampaignId);
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

  // Ask the courier where the parcels in flight have got to, once the list is
  // on screen rather than while rendering it. Steadfast's webhook was meant to
  // push this and only ever pushes "in_review", and the cron that fetches it
  // instead runs once a day — so the page that somebody is about to make
  // decisions on brings itself up to date. Throttled server-side, so opening
  // the list repeatedly asks the courier once.
  const statusChecked = useRef(false);
  useEffect(() => {
    if (statusChecked.current) return;
    statusChecked.current = true;
    refreshCourierStatuses(slug).then((res) => {
      if (res.ok && res.delivered > 0) {
        toast.success(
          `${res.delivered} parcel(s) marked delivered — the courier says they arrived`,
        );
        router.refresh();
      }
    });
  }, [slug, router]);

  // Arriving from a call-list row opens the order form already pointed at that
  // customer. Runs once per arrival.
  const leadPrefilled = useRef(false);
  // The lead this form is filling in for, held here rather than read from the
  // prop: ?fromLead is cleared out of the URL as soon as it has been used, so
  // the prop goes null while the form is still open. State, not a ref, because
  // the dialog shows what the caller wrote down — held in a ref it flashed up
  // and vanished on the re-render that followed the URL being cleaned.
  const [activeLead, setActiveLead] = useState<FromLead | null>(null);
  useEffect(() => {
    if (!fromLead || leadPrefilled.current || !perms.canAdd) return;
    leadPrefilled.current = true;
    setActiveLead(fromLead);
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
    // Matched by id, so this is a fact rather than a guess — see FromLead.combos.
    if (fromLead.combos.length > 0) {
      setComboPicks(
        fromLead.combos.map((c) => ({
          comboSetId: c.comboSetId,
          quantity: String(c.quantity),
        })),
      );
    }
    setDeliveryType("COURIER");
    // The caller already agreed a shipping charge; retyping it is how the
    // order and the call end up quoting the customer two different figures.
    if (fromLead.deliveryCharge > 0) setDeliveryCharge(String(fromLead.deliveryCharge));
    setOpen(true);
    // The parameter has done its job the moment the fields are filled, so it
    // comes out of the URL. Left in, it re-opened this form on every reload of
    // the sales page — for a lead that had already become an order, hours
    // earlier — and the way out was to notice the query string and edit it.
    // Only these two go: the list's own filters live in the URL too.
    const params = new URLSearchParams(window.location.search);
    params.delete("fromLead");
    params.delete("customerId");
    router.replace(`${window.location.pathname}${params.size ? `?${params}` : ""}`, {
      scroll: false,
    });
  }, [fromLead, perms.canAdd, router]);

  function resetForm() {
    // A blank form belongs to no lead. Cleared here so that "+ New order",
    // opened after one was created from the call list, can't link the next
    // order to the previous one's row.
    setActiveLead(null);
    // Now, in Dhaka — the form asks for a time as well as a day, so a new order
    // opens on the moment it is being taken rather than on midnight.
    setOrderDate(toDhakaInputValue(new Date()));
    setItems([emptyItem()]);
    setComboPicks([]);
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
    setGiveaway(false);
  }

  const selectedCourier = couriers.find((c) => c.id === courierId) ?? null;

  /** Switching courier drops the zone: zones belong to one courier. */
  function onCourierChange(next: string) {
    setCourierId(next);
    setCourierZoneId(NONE);
  }

  const comboById = useMemo(() => new Map(combos.map((c) => [c.id, c])), [combos]);

  /** The combos on this order, resolved to their offers. */
  const pickedCombos = useMemo(
    () =>
      comboPicks
        .map((p) => ({ combo: comboById.get(p.comboSetId), quantity: parseInt(p.quantity) || 0 }))
        .filter((p): p is { combo: ComboOptionForOrder; quantity: number } => !!p.combo && p.quantity > 0),
    [comboPicks, comboById],
  );

  /** Does anything on this order carry free delivery as part of the offer? */
  const comboFreeDelivery = pickedCombos.some((p) => p.combo.freeDelivery);
  const freeDeliveryApplied = useRef(false);
  useEffect(() => {
    // Once, on the transition into "this order has a free-delivery combo".
    // A prefill that ran on every render would fight anyone who deliberately
    // typed a charge — a free-delivery combo plus a heavy second product is a
    // real order, and the shop may still want something for the parcel.
    if (comboFreeDelivery && !freeDeliveryApplied.current) {
      freeDeliveryApplied.current = true;
      setDeliveryCharge("0");
    }
    if (!comboFreeDelivery) freeDeliveryApplied.current = false;
  }, [comboFreeDelivery]);

  /**
   * What the customer is paying for goods, however they were picked.
   *
   * One figure rather than the three separate `items.reduce` loops the courier
   * quote, the break-even and the preview each used to keep — which agreed
   * only for as long as nobody added a way of putting goods on an order.
   * Combos were exactly that: priced as sets, they belong in every one of
   * those sums, and three copies is three chances to forget.
   */
  const goodsSubtotal = useMemo(() => {
    const loose = items.reduce((s, it) => {
      const price = parseFloat(it.unitPrice) || 0;
      const qty = parseInt(it.quantity) || 0;
      return s + price * qty - (parseFloat(it.discount) || 0);
    }, 0);
    const sets = pickedCombos.reduce((s, p) => s + p.combo.price * p.quantity, 0);
    return round2(loose + sets);
  }, [items, pickedCombos]);

  // Weight from the goods themselves, so nobody has to guess. Only offered
  // when EVERY line knows its own weight — a partial sum would be confidently
  // wrong and quietly under-quote the parcel. A combo counts as the pieces
  // inside it, which is what actually goes in the box.
  const suggestedWeightKg = useMemo(() => {
    const picked = items.filter((it) => it.variant);
    if (picked.length === 0 && pickedCombos.length === 0) return null;
    let grams = 0;
    for (const it of picked) {
      const g = it.variant?.weightGrams;
      if (g == null) return null;
      grams += g * (parseInt(it.quantity) || 0);
    }
    for (const p of pickedCombos) {
      for (const k of p.combo.components) {
        if (k.weightGrams == null) return null;
        grams += k.weightGrams * k.quantity * p.quantity;
      }
    }
    return grams > 0 ? Math.round((grams / 1000) * 1000) / 1000 : null;
  }, [items, pickedCombos]);

  // What the courier will actually keep, previewed while the charge is being
  // set rather than discovered on a statement weeks later.
  const courierQuote = useMemo(() => {
    if (deliveryType !== "COURIER" || !selectedCourier) return null;
    const zone = selectedCourier.zones.find((z) => z.id === courierZoneId);
    if (!zone) return null;
    const goods = goodsSubtotal;
    // Only what the courier itself collects carries the fee — a bKash
    // prepayment travels by courier too, but there's nothing to collect.
    const codAmount =
      paymentMethod === "COURIER_COLLECTION"
        ? goods - (parseFloat(orderDiscount) || 0) + (parseFloat(deliveryCharge) || 0)
        : 0;
    return quoteCourier(selectedCourier, {
      zoneRate: zone.rate,
      bands: zone.bands,
      weightKg: parseFloat(weightKg) || suggestedWeightKg,
      codAmount,
    });
  }, [
    deliveryType,
    selectedCourier,
    courierZoneId,
    goodsSubtotal,
    orderDiscount,
    deliveryCharge,
    weightKg,
    suggestedWeightKg,
    paymentMethod,
  ]);

  const deliveryShortfall = courierQuote
    ? Math.round((courierQuote.total - (parseFloat(deliveryCharge) || 0)) * 100) / 100
    : 0;

  // A zone priced in bands charges by weight, and an unweighed parcel is quoted
  // at the TOP band on purpose — under-quoting a parcel is the mistake that
  // hides, because it makes an order look more profitable than it was. But it
  // is still a guess, and nothing on the screen said so: 86 products with no
  // weight between them meant every light Dhaka parcel was costed at 65 when
  // Steadfast charges 55, and the ten taka only surfaced as an unexplained gap
  // against a payout weeks later. Says which band it could drop to, so the
  // person filling the form knows there is a number worth entering.
  const unweighedBand = useMemo(() => {
    if (deliveryType !== "COURIER" || !selectedCourier) return null;
    if (parseFloat(weightKg) || suggestedWeightKg) return null;
    const zone = selectedCourier.zones.find((z) => z.id === courierZoneId);
    if (!zone || zone.bands.length < 2) return null;
    const sorted = [...zone.bands].sort((a, b) => a.uptoKg - b.uptoKg);
    const lightest = sorted[0];
    // Nothing to say when the light band costs the same as the heavy one.
    return lightest.rate < sorted[sorted.length - 1].rate ? lightest : null;
  }, [deliveryType, selectedCourier, courierZoneId, weightKg, suggestedWeightKg]);

  const breakEven = useMemo(() => {
    if (!courierQuote || !selectedCourier) return null;
    const zone = selectedCourier.zones.find((z) => z.id === courierZoneId);
    if (!zone) return null;
    return breakEvenDeliveryCharge(selectedCourier, {
      zoneRate: zone.rate,
      bands: zone.bands,
      weightKg: parseFloat(weightKg) || suggestedWeightKg,
      goodsAmount: goodsSubtotal - (parseFloat(orderDiscount) || 0),
    });
  }, [courierQuote, selectedCourier, courierZoneId, goodsSubtotal, orderDiscount, weightKg, suggestedWeightKg]);

  const editCourier = couriers.find((c) => c.id === editCourierId) ?? null;
  const editCourierQuote = useMemo(() => {
    if (!editOrder || editDeliveryType !== "COURIER" || !editCourier) return null;
    const zone = editCourier.zones.find((z) => z.id === editCourierZoneId);
    if (!zone) return null;
    const goods = editOrder.totals.customerTotal - editOrder.deliveryCharge;
    return quoteCourier(editCourier, {
      zoneRate: zone.rate,
      bands: zone.bands,
      weightKg: parseFloat(editWeightKg) || null,
      // A cancelled parcel collected nothing to be charged a percentage on.
      codAmount:
        editOrder.status === "CANCELLED" || editPaymentMethod !== "COURIER_COLLECTION"
          ? 0
          : goods + editOrder.deliveryCharge,
    });
  }, [editOrder, editDeliveryType, editCourier, editCourierZoneId, editWeightKg, editPaymentMethod]);

  const preview = useMemo(() => {
    const itemsSubtotal = goodsSubtotal;
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
  }, [deliveryCharge, deliveryCost, deliveryType, gifts, goodsSubtotal, orderDiscount, packagingCost]);

  function updateGift(i: number, patch: Partial<GiftDraft>) {
    setGifts((prev) => prev.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  }

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
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
    const cleanCombos = pickedCombos.map((p) => ({
      comboSetId: p.combo.id,
      quantity: p.quantity,
    }));
    if (cleanItems.length === 0 && cleanCombos.length === 0) {
      toast.error("Add at least one item or combo");
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

    // The same arithmetic the server runs before it writes anything: one
    // demand figure per variant, whatever it arrived as. Two combos each
    // containing an aeroplane plus a third aeroplane on its own is a demand of
    // three, and gets checked as three.
    //
    // The per-row "only N can be made" note cannot see that — it reads one
    // combo at a time, and knows nothing about the loose lines or the gifts —
    // so a basket that overdrew a shelf across rows was filled in, sent, and
    // refused on the way back, with the form still on screen.
    //
    // Advisory, not authoritative. These stock figures were read when the form
    // was opened; the server re-reads them inside the transaction and stays
    // the one that decides. If a delivery lands while the form is open this
    // will refuse an order that would in fact go through — reopening the form
    // clears it, and being told early is worth that.
    const known = new Map<string, { stock: number; label: string }>();
    for (const it of items) {
      if (it.variant) {
        known.set(it.variant.value, { stock: it.variant.stock, label: it.variant.label });
      }
    }
    for (const g of gifts) {
      if (g.mode === "PRODUCT" && g.variant) {
        known.set(g.variant.value, { stock: g.variant.stock, label: g.variant.label });
      }
    }
    for (const p of pickedCombos) {
      for (const k of p.combo.components) {
        known.set(k.productVariantId, { stock: k.stock, label: k.label });
      }
    }

    const short = stockShortfall(
      [
        ...cleanItems.map((it) => ({
          productVariantId: it.productVariantId,
          quantity: it.quantity,
        })),
        ...cleanGifts
          .filter((g) => g.productVariantId)
          .map((g) => ({ productVariantId: g.productVariantId, quantity: g.quantity })),
        ...pickedCombos.flatMap((p) =>
          p.combo.components.map((k) => ({
            productVariantId: k.productVariantId,
            quantity: k.quantity * p.quantity,
          })),
        ),
      ],
      new Map([...known].map(([id, k]) => [id, k.stock])),
    );
    if (short.length > 0) {
      toast.error(
        `Not enough stock — ${short
          .map((r) => `${known.get(r.productVariantId)?.label ?? "item"}: need ${r.need}, ${r.have} in stock`)
          .join("; ")}`,
      );
      return;
    }
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("customerId", customer?.value ?? "");
    fd.set("heldByMembershipId", heldById === NONE ? "" : heldById);
    fd.set("status", status);
    fd.set("deliveryType", deliveryType);
    fd.set("paymentMethod", paymentMethod);
    fd.set("isGiveaway", giveaway ? "1" : "");
    fd.set("paymentStatus", paymentStatus);
    // The weight the quote above was worked out on, not the empty box it was
    // read from. Leaving the field blank showed "~0.2kg from the items' own
    // weights" and a 55 delivery cost on screen, then saved no weight at all —
    // and a parcel with no weight is priced at the zone's TOP band, so the
    // order stored 65. Every light Dhaka parcel was costed ten taka high, and
    // the preview that would have given it away was the one screen showing the
    // right number.
    if (!weightKg && suggestedWeightKg !== null) fd.set("weightKg", String(suggestedWeightKg));
    fd.set("items", JSON.stringify(cleanItems));
    fd.set("gifts", JSON.stringify(cleanGifts));
    // Sets, not lines: the server reads each combo's price from the recipe and
    // writes the component rows itself (see expandCombos).
    fd.set("combos", JSON.stringify(cleanCombos));
    const res = await createOrder(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    // Point the call-list row at the order it just became, so that list can
    // show where the parcel got to without anyone re-typing it. A failure here
    // costs the link, not the order — say so rather than implying both failed.
    const lead = activeLead;
    if (lead && res.id) {
      const linked = await linkLeadToOrder(slug, lead.leadId, res.id);
      // The lead already knows which channel the customer came through, and
      // the order form has no field for it — carry it across rather than
      // leaving one more order tagged "Not set".
      if (lead.channel) await setOrderSource(slug, res.id, lead.channel);
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
        setCancelInTransit(goodsLikelyWithCourier(order));
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
      goodsInTransit: cancelInTransit,
    });
    setCancelSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Order cancelled");
    setCancelling(null);
    router.refresh();
  }

  /** Opens the payment dialog on the instalment it is nearly always for. */
  function openPayment(order: OrderRow) {
    // A cancelled order has no balance to pay down — what was handed over on
    // the doorstep of a refused parcel is the cancellation's own figure, and
    // the dialog would read every one of them as fully paid. Said here rather
    // than letting the server refuse it after the amount has been typed.
    if (order.status === "CANCELLED") {
      return toast.error(
        "This order is cancelled — record what was collected in the cancellation costs instead.",
      );
    }
    setPartPaidAmount("");
    setPartMode("add");
    setPartPaying(order);
  }

  async function onPaymentStatusChange(orderId: string, newStatus: string) {
    // "Some of it" is not an amount, and every due figure needs one. Ask now,
    // while whoever took the money is still standing there.
    if (newStatus === "PARTIAL") {
      const order = orders.find((o) => o.id === orderId);
      if (order) {
        openPayment(order);
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
    const typed = parseFloat(partPaidAmount) || 0;
    setPartPaySaving(true);
    // Two different questions, so two different actions: an instalment is
    // added to what the order already holds (server-side, so two people taking
    // money the same afternoon can't overwrite each other), while a correction
    // replaces the running total outright.
    const res =
      partMode === "add"
        ? await recordPayment(slug, partPaying.id, typed)
        : await updatePaymentStatus(slug, partPaying.id, "PARTIAL", typed);
    setPartPaySaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(partMode === "add" ? "Payment recorded" : "Recorded total corrected");
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
    // Off by default: most returns are written down with the box open on the
    // counter, and that is what every return before this column assumed.
    setReturnInTransit(false);
    setReturnOpen(true);
  }

  async function onSubmitReturn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!returnItemId) return toast.error("Select an item to return");
    const fd = new FormData(e.currentTarget);
    fd.set("orderItemId", returnItemId);
    if (returnInTransit) fd.set("goodsInTransit", "1");
    const res = await createReturn(slug, fd);
    if (!res.ok) return toast.error(res.error);
    toast.success("Return recorded");
    setReturnOpen(false);
    router.refresh();
  }

  function openEdit(o: OrderRow) {
    setEditPackaging(String(o.packagingCost));
    setEditGiveaway(o.isGiveaway);
    setEditInTransit(o.returnLeg === "IN_TRANSIT");
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
    fd.set("isGiveaway", editGiveaway ? "1" : "");
    // Set from state rather than left to the checkbox: an unticked box posts
    // nothing, and here "nothing" has to mean "the goods are back", not "the
    // form didn't ask". The hidden goodsInTransitAsked marker draws that line.
    fd.set("goodsInTransit", editInTransit ? "1" : "");
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
              placeholder="Search name, phone or courier ID…"
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
                  {/* The name goes to the buyer's history — what they have
                      ordered before, what they still owe — which is the
                      question a name in this list most often raises. Only when
                      it IS the buyer's name: a parcel shipped to someone else
                      is addressed to a person who has no page of their own,
                      and the account underneath carries the link instead.
                      Walk-ins have no record to open. Underlined on hover
                      rather than always: this is the app's densest table, and
                      fifty permanent underlines read as noise. */}
                  {o.customerId && o.recipientName === o.customerName ? (
                    <Link
                      href={`/${slug}/customers/${o.customerId}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {o.recipientName}
                    </Link>
                  ) : (
                    o.recipientName
                  )}
                  {/* Only when the two disagree: the row is findable by the
                      name it shipped under, and the buyer it belongs to is
                      still visible underneath. */}
                  {o.recipientName !== o.customerName && (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (account:{" "}
                      {o.customerId ? (
                        <Link
                          href={`/${slug}/customers/${o.customerId}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {o.customerName}
                        </Link>
                      ) : (
                        o.customerName
                      )}
                      )
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
                  {/* Said in the row rather than left to be inferred from a
                      total of 0: a giveaway and an order somebody hasn't been
                      invoiced for read the same in a list otherwise. */}
                  {o.isGiveaway && (
                    <Badge
                      variant="outline"
                      className="ml-1.5 border-violet-500/60 text-violet-700 dark:text-violet-400"
                      title="The goods went out free"
                    >
                      Free
                    </Badge>
                  )}
                </span>
              ),
            },
            // Near the front rather than down with the other optional columns:
            // when it is on at all it is because somebody is matching this list
            // against a courier statement line by line, and a number they have
            // to look sideways for defeats the point. Not first — the customer
            // column is the mobile card's title line.
            ...(showColumn("orderId")
              ? [
                  {
                    key: "orderId",
                    header: "Order ID",
                    cell: (o: OrderRow) =>
                      o.orderNo == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="tabular-nums">#{o.orderNo}</span>
                      ),
                    sortValue: (o: OrderRow) => o.orderNo ?? 0,
                  },
                ]
              : []),
            {
              key: "date",
              header: "Date",
              cell: (o) => <Stamp date={o.date} time={o.time} entered={o.entered} />,
            },
            {
              key: "status",
              header: "Status",
              cell: (o) => (
                // Two lines on a cancelled parcel: the sale's state, and the
                // goods'. They answer different questions and stopped agreeing
                // the day cancelling stopped meaning "back on the shelf".
                <div className="flex flex-col items-start gap-1">
                  {perms.canEdit ? (
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
                  )}
                  <ReturnLegBadge order={o} />
                </div>
              ),
            },
            {
              key: "payment",
              header: "Payment",
              cell: (o) => (
                // Wraps in the mobile card (narrow value area) but stays a
                // single line in the desktop table.
                <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 md:flex-nowrap md:justify-start">
                  {/* A cancelled order has no payment status worth showing. The
                      sale was undone, so there is nothing to settle and nothing
                      owed — every money figure in the app (amountCollected,
                      depositAmount, the courier balance, profit) reads the
                      cancellation's own collected amount instead and ignores
                      this column entirely.

                      Left as the dropdown it read "UNPAID" on a refused parcel
                      where the customer had handed the delivery charge over at
                      the door, which says the opposite of what happened; and
                      picking PARTIAL to correct it opened the instalment dialog,
                      which recordPayment can only refuse — there is no balance
                      on a cancelled order to pay down. What was collected is
                      edited where it was entered, on the order itself. */}
                  {o.status === "CANCELLED" ? (
                    o.cancelledCollected > 0 ? (
                      <span
                        className="whitespace-nowrap font-medium text-amber-700 dark:text-amber-400"
                        title="Taken at the door on a refused parcel. Change it in Edit order → Collected on a partial delivery."
                      >
                        <Money value={o.cancelledCollected} /> collected
                      </span>
                    ) : (
                      <span
                        className="whitespace-nowrap text-muted-foreground"
                        title="Nothing was taken at the door. Change it in Edit order → Collected on a partial delivery."
                      >
                        Nothing collected
                      </span>
                    )
                  ) : perms.canEdit ? (
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
                      what is still owed, which is the only part that matters.
                      Not on a cancelled one: an order cancelled after an advance
                      keeps the old PARTIAL in the column, and nothing is owed on
                      a sale that was undone — it would print "৳0 due" beside the
                      collected figure and invite the reader to chase it. */}
                  {o.paymentStatus === "PARTIAL" && o.status !== "CANCELLED" && (
                    <span className="whitespace-nowrap text-xs text-muted-foreground">
                      <Money value={o.amountPaid} /> paid · <Money value={o.amountDue} /> due
                    </span>
                  )}
                  {/* PAID on an order the customer underpaid is the truth and
                      reads like a lie: nothing is still owed, because the gap
                      was written off, and a row saying only "PAID" hides that
                      it ever happened. The status answers "is anything still
                      to collect"; this answers "did it all arrive", and the
                      two are different questions on exactly these orders. */}
                  {o.collectionShortfall > 0 && (
                    <span
                      className="whitespace-nowrap text-xs text-destructive"
                      title={
                        o.collectionNote ??
                        "The courier's ledger came up short of the invoice — recorded on the courier balance page"
                      }
                    >
                      <Money value={o.collectionShortfall} /> short of{" "}
                      <Money value={o.totals.customerTotal} />
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
                          courierStatus={o.courierStatus}
                          orderStatus={o.status}
                          onApplyStatus={onStatusChange}
                          canBook={
                            !o.courierTrackingId &&
                            o.status !== "CANCELLED" &&
                            couriers.some((c) => c.id === o.courierId && c.apiConnected)
                          }
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
                        valueLabel={o.boostCampaignName}
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
              // Everything behind one button. Invoice and Breakdown used to sit
              // out here as inline links — two nowrap labels on every row, on
              // the widest table in the app, for two documents opened once per
              // order at most. The menu already existed next to them.
              cell: (o: OrderRow) => (
                <div className="flex flex-nowrap items-center justify-end">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions" />}
                    >
                      <MoreVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/* Real links, so middle-click and "open in new tab"
                          still work the way they did as plain anchors. */}
                      <DropdownMenuItem
                        render={<Link href={`/${slug}/sales/orders/${o.id}/invoice`} />}
                      >
                        Invoice
                      </DropdownMenuItem>
                      {perms.canViewProfit && (
                        <DropdownMenuItem
                          render={<Link href={`/${slug}/sales/orders/${o.id}/breakdown`} />}
                        >
                          Breakdown
                        </DropdownMenuItem>
                      )}
                      {perms.canEdit && (
                        <>
                          {/* The instalment path. Before this the only way to
                              take a second payment was to reopen the payment
                              dropdown and pick the status it was already on,
                              which nothing anywhere suggested. */}
                          {o.status !== "CANCELLED" && o.amountDue > 0 && (
                            <DropdownMenuItem onClick={() => openPayment(o)}>
                              Record a payment
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => openEdit(o)}>
                            Edit details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openReturn(o)}>Return</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => onDelete(o.id)}>
                            Delete
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
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
              {activeLead ? `New order for ${activeLead.customerName}` : "New order"}
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Add products first, then payment and delivery details.
            </p>
            {/* What the caller wrote down, shown rather than auto-added: lead
                items are free text and a wrong catalogue match would put the
                wrong cost on the order and take the wrong item out of stock. */}
            {activeLead && (
              <div className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm">
                <div className="font-medium">From the call list</div>
                <div className="text-muted-foreground">
                  {activeLead.itemsText || "No items were written down"}
                  {activeLead.total > 0 && ` · agreed total ${formatMoney(activeLead.total)}`}
                </div>
                {activeLead.address && (
                  <div className="text-muted-foreground">{activeLead.address}</div>
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
                {combos.length > 0 && (
                  <section className="space-y-3 rounded-xl bg-muted/25 p-3 ring-1 ring-border sm:p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold">Combo sets</h3>
                        <p className="text-xs text-muted-foreground">
                          Priced as a set. Saved as the products inside it, so stock comes off
                          every one of them.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setComboPicks([...comboPicks, { comboSetId: NONE, quantity: "1" }])
                        }
                      >
                        <Plus />
                        Add combo
                      </Button>
                    </div>

                    {comboPicks.length > 0 && (
                      <div className="space-y-3">
                        {comboPicks.map((pick, i) => {
                          const combo = comboById.get(pick.comboSetId) ?? null;
                          const qty = parseInt(pick.quantity) || 0;
                          // The bottleneck, named. "None left" on its own sends
                          // somebody to the product list to work out which of
                          // five things ran out.
                          const shortest = combo?.components.length
                            ? combo.components.reduce((worst, k) =>
                                Math.floor(k.stock / k.quantity) <
                                Math.floor(worst.stock / worst.quantity)
                                  ? k
                                  : worst,
                              )
                            : null;
                          const overBuildable = combo ? qty > combo.buildable : false;
                          return (
                            <div
                              key={i}
                              className="rounded-xl bg-background p-3 ring-1 ring-border sm:p-4"
                            >
                              <div className="grid grid-cols-[minmax(0,1fr)_5rem_2.25rem] items-end gap-2">
                                <div className="space-y-2">
                                  <Label>Combo</Label>
                                  <Select
                                    value={pick.comboSetId}
                                    // Base UI reads the closed trigger's label from
                                    // here, not from the options — those live in a
                                    // portal that does not exist until the popup is
                                    // first opened, so without this map the trigger
                                    // has only the value to show, and the value is a
                                    // cuid. Every other id-valued select on this form
                                    // passes it; this one did not.
                                    items={[
                                      { value: NONE, label: "Choose a combo" },
                                      ...combos.map((c) => ({
                                        value: c.id,
                                        label: comboLabel(c),
                                      })),
                                    ]}
                                    onValueChange={(v) =>
                                      setComboPicks((prev) =>
                                        prev.map((p, j) =>
                                          j === i ? { ...p, comboSetId: v ?? NONE } : p,
                                        ),
                                      )
                                    }
                                  >
                                    <SelectTrigger className="w-full">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value={NONE}>Choose a combo</SelectItem>
                                      {combos.map((c) => (
                                        <SelectItem key={c.id} value={c.id}>
                                          {comboLabel(c)}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-2">
                                  <Label>Sets</Label>
                                  <Input
                                    type="number"
                                    min="1"
                                    inputMode="numeric"
                                    value={pick.quantity}
                                    aria-invalid={overBuildable || undefined}
                                    onChange={(e) =>
                                      setComboPicks((prev) =>
                                        prev.map((p, j) =>
                                          j === i ? { ...p, quantity: e.target.value } : p,
                                        ),
                                      )
                                    }
                                  />
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={`Remove combo ${i + 1}`}
                                  onClick={() =>
                                    setComboPicks(comboPicks.filter((_, j) => j !== i))
                                  }
                                >
                                  <Trash2 />
                                </Button>
                              </div>

                              {combo && (
                                <>
                                  <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
                                    {combo.components.map((k) => (
                                      <li
                                        key={k.productVariantId}
                                        className="flex justify-between gap-3"
                                      >
                                        <span className="truncate">
                                          {k.label} ×{k.quantity * Math.max(qty, 1)}
                                        </span>
                                        <span className="shrink-0 tabular-nums">
                                          {k.stock} in stock
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                                    <span
                                      className={
                                        overBuildable
                                          ? "text-destructive"
                                          : "text-muted-foreground"
                                      }
                                    >
                                      {overBuildable
                                        ? `Only ${combo.buildable} can be made — ${shortest?.label ?? "a component"} is short`
                                        : combo.freeDelivery
                                          ? "Free delivery with this combo"
                                          : `Saves ${formatMoney(Math.max(0, combo.listTotal - combo.price))} against buying separately`}
                                    </span>
                                    <span className="font-medium tabular-nums">
                                      Line total {formatMoney(combo.price * Math.max(qty, 0))}
                                    </span>
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                )}

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
                      <Input
                        id="o-date"
                        name="date"
                        type="datetime-local"
                        required
                        value={orderDate}
                        onChange={(e) => setOrderDate(e.target.value)}
                      />
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
                      <Field
                        name="deliveryCharge"
                        label="Charge from customer"
                        hint={
                          comboFreeDelivery
                            ? "Free delivery comes with this combo. What the courier charges still goes in delivery cost below, so the promotion shows up as what it costs."
                            : undefined
                        }
                      >
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
                                {unweighedBand && (
                                  <>
                                    {" "}
                                    No weight entered, so this is the heaviest band — under{" "}
                                    {unweighedBand.uptoKg}kg it is{" "}
                                    <Money value={unweighedBand.rate} />.
                                  </>
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
                          value={giveaway ? "" : orderDiscount}
                          onChange={(e) => setOrderDiscount(e.target.value)}
                          readOnly={giveaway}
                          placeholder={giveaway ? "Whole amount — it's free" : undefined}
                          className={giveaway ? "text-muted-foreground" : undefined}
                        />
                      </div>
                    </div>
                    <label className="flex items-start gap-2 text-sm">
                      <Checkbox
                        checked={giveaway}
                        onCheckedChange={(v) => setGiveaway(v === true)}
                        className="mt-0.5"
                      />
                      <span>
                        Free — the customer pays nothing for the goods
                        <span className="block text-xs text-muted-foreground">
                          The price comes off automatically. Delivery is separate: leave the
                          charge at 0 and fill in the delivery cost for the shop to pay the
                          courier too.
                        </span>
                      </span>
                    </label>
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
                {cancelling.customerName}&apos;s order stops counting as a sale, and the
                goods go back into stock once they are actually back. Anything it
                already cost is recorded below and comes off profit — leave a field at 0
                if it never happened.
              </p>

              {/* The one question the money fields can't answer. A refused
                  parcel spends days in the courier's return hub, and putting
                  its pieces back on the shelf tonight is how the shop sells
                  something nobody has. */}
              <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <Checkbox
                  checked={cancelInTransit}
                  onCheckedChange={(v) => setCancelInTransit(v === true)}
                  className="mt-0.5"
                />
                <span>
                  The goods are still with the courier
                  <span className="block text-xs text-muted-foreground">
                    They stay out of stock until you mark the parcel received, so nobody
                    can sell them while they&apos;re in transit. Untick it if the goods
                    are already back on the shelf — never packed, or handed straight back
                    at the door.
                  </span>
                </span>
              </label>

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

      {/* Payment dialog. PARTIAL used to be a status with no figure behind it,
          so a 3,000 advance on a 5,000 order left the app chasing the whole
          5,000 and holding the 3,000 nowhere at all. It then asked for the
          total paid so far, which works exactly once: the second instalment
          made whoever took the money add it to a figure they had to remember
          first. This asks what changed hands. */}
      <Dialog open={!!partPaying} onOpenChange={(o) => !o && setPartPaying(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {partMode === "add" ? "Record a payment" : "Correct the recorded total"}
            </DialogTitle>
          </DialogHeader>
          {partPaying &&
            (() => {
              const total = partPaying.totals.customerTotal;
              // Read off the due rather than amountPaid: PAID means the whole
              // total whatever that column holds, and the server works from
              // the same rule.
              const already = round2(Math.max(0, total - partPaying.amountDue));
              const typed = parseFloat(partPaidAmount) || 0;
              const nextTotal = partMode === "add" ? round2(already + typed) : round2(typed);
              const remaining = round2(Math.max(0, total - nextTotal));
              return (
                <form key={partPaying.id} onSubmit={onConfirmPartial} className="space-y-4">
                  {/* The three figures the person on the phone is being asked
                      about, before they are asked anything. */}
                  <dl className="space-y-1 rounded-lg bg-muted/40 p-3 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">
                        {partPaying.customerName}&apos;s order
                      </dt>
                      <dd className="font-medium tabular-nums">
                        <Money value={total} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Paid so far</dt>
                      <dd className="tabular-nums">
                        <Money value={already} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">Still due</dt>
                      <dd className="font-medium tabular-nums">
                        <Money value={partPaying.amountDue} />
                      </dd>
                    </div>
                  </dl>
                  <Field
                    name="amountPaid"
                    label={partMode === "add" ? "Amount received now" : "Total paid so far"}
                    required
                    hint={
                      partMode === "add"
                        ? `At most ${formatMoney(partPaying.amountDue)}`
                        : "Replaces the figure already recorded — for fixing a typo, not for a new instalment"
                    }
                  >
                    <MoneyInput
                      min="0"
                      required
                      autoFocus
                      value={partPaidAmount}
                      onChange={(e) => setPartPaidAmount(e.target.value)}
                    />
                  </Field>
                  {typed > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {remaining > 0 ? (
                        <>
                          Leaves <Money value={nextTotal} /> paid of <Money value={total} /> —{" "}
                          <Money value={remaining} /> still due.
                        </>
                      ) : (
                        // Settling exactly is the common way an instalment plan
                        // ends, and it should not need a second trip to the
                        // status dropdown afterwards.
                        <>Settles the order in full — it will be marked paid.</>
                      )}
                    </p>
                  )}
                  {/* Only worth offering once there is a figure to be wrong. */}
                  {already > 0 && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline underline-offset-2"
                      onClick={() => {
                        setPartMode(partMode === "add" ? "correct" : "add");
                        setPartPaidAmount(partMode === "add" ? String(already) : "");
                      }}
                    >
                      {partMode === "add"
                        ? "The recorded total is wrong — correct it instead"
                        : "← Back to recording a payment"}
                    </button>
                  )}
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
                      {partPaySaving ? "Saving…" : partMode === "add" ? "Record payment" : "Save"}
                    </Button>
                  </DialogFooter>
                </form>
              );
            })()}
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
              {/* Same gap a cancelled parcel has: agreed on the phone today,
                  in the post for a week. The refund moves now either way — only
                  the shelf waits. */}
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={returnInTransit}
                  onCheckedChange={(v) => setReturnInTransit(v === true)}
                  className="mt-0.5"
                />
                <span>
                  They&apos;ve sent it but it hasn&apos;t arrived
                  <span className="block text-xs text-muted-foreground">
                    Keeps the pieces out of stock until you mark them received. Leave it
                    unticked if the goods are already back.
                  </span>
                </span>
              </label>
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
                  <Input
                    id="eo-date"
                    name="date"
                    type="datetime-local"
                    required
                    defaultValue={editOrder.dateInput}
                  />
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

              {/* The way back in for a cancellation recorded without it — the
                  box missed on the day, or an order cancelled before any of
                  this existed. Offered only while the leg is still open: once
                  the goods have been booked in or written off, that was an
                  action with stock adjustments behind it, and a header edit
                  has no business undoing them. */}
              {editOrder.status === "CANCELLED" &&
                (editOrder.returnLeg === "NONE" || editOrder.returnLeg === "IN_TRANSIT" ? (
                  <>
                    {/* Marks that the form asked at all: an unticked checkbox
                        posts nothing, so without this every other order's
                        header edit would read as "the goods are back". */}
                    <input type="hidden" name="goodsInTransitAsked" value="1" />
                    <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                      <Checkbox
                        checked={editInTransit}
                        onCheckedChange={(v) => setEditInTransit(v === true)}
                        className="mt-0.5"
                      />
                      <span>
                        The goods are still with the courier
                        <span className="block text-xs text-muted-foreground">
                          Ticked, this parcel joins the &quot;coming back&quot; list and its
                          pieces stay out of stock until you mark them received. Untick it
                          once they are on the shelf.
                        </span>
                      </span>
                    </label>
                  </>
                ) : (
                  <p className="rounded-md border p-3 text-sm text-muted-foreground">
                    {editOrder.returnLeg === "RECEIVED"
                      ? "These goods were booked back in"
                      : "This parcel was written off as never returned"}
                    {editOrder.returnLegOn ? ` on ${editOrder.returnLegOn}` : ""}. Anything
                    that needs correcting now is a stock adjustment.
                  </p>
                ))}
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
                    // A giveaway's discount is the goods total, worked out on
                    // save — so it isn't editable, rather than accepting a
                    // number it will then ignore (as the gift cost does).
                    readOnly={editGiveaway}
                    className={editGiveaway ? "text-muted-foreground" : undefined}
                  />
                  <label className="mt-2 flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={editGiveaway}
                      onCheckedChange={(v) => setEditGiveaway(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      Free — the customer pays nothing for the goods
                      <span className="block text-xs text-muted-foreground">
                        Delivery is separate: set the charge to 0 and keep the delivery cost
                        for the shop to pay the courier too.
                      </span>
                    </span>
                  </label>
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
