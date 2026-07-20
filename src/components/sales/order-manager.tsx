"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createOrder,
  updateOrderStatus,
  updatePaymentStatus,
  updateCourierTrackingId,
  createReturn,
  deleteOrder,
} from "@/server/actions/orders";
import { Button } from "@/components/ui/button";
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
import { Plus, ShoppingCart, Trash2, MoreVertical } from "lucide-react";

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
  customerName: string;
  status: string;
  deliveryType: string;
  courierTrackingId: string | null;
  paymentStatus: string;
  paymentMethod: string;
  heldByName: string | null;
  totals: { customerTotal: number; netProfit: number; returnedUnits: number };
  items: OrderItem[];
};
type Perms = { canAdd: boolean; canEdit: boolean; canViewProfit: boolean };
type ItemDraft = {
  variant: SearchVariantOption | null;
  unitPrice: string;
  quantity: string;
  discount: string;
};

const STATUSES = ["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"];
const DELIVERY = ["SELF", "COURIER"];
const METHODS = ["CASH", "BKASH", "NAGAD", "COURIER_COLLECTION", "OTHER"];
const PAY_STATUS = ["UNPAID", "PAID", "PARTIAL"];
const NONE = "__none__";

function emptyItem(): ItemDraft {
  return { variant: null, unitPrice: "", quantity: "1", discount: "0" };
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

function formatMoney(value: number) {
  return `৳${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
  orders,
  perms,
}: {
  slug: string;
  hasProducts: boolean;
  members: { id: string; label: string }[];
  orders: OrderRow[];
  perms: Perms;
}) {
  const router = useRouter();

  // ── New-order dialog state ──
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [customer, setCustomer] = useState<ComboOption | null>(null);
  const [heldById, setHeldById] = useState(NONE);
  const [status, setStatus] = useState("PENDING");
  const [deliveryType, setDeliveryType] = useState("SELF");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [paymentStatus, setPaymentStatus] = useState("UNPAID");
  const [deliveryCharge, setDeliveryCharge] = useState("0");
  const [deliveryCost, setDeliveryCost] = useState("");
  const [packagingCost, setPackagingCost] = useState("0");
  const [giftCost, setGiftCost] = useState("0");
  const [orderDiscount, setOrderDiscount] = useState("0");

  // ── Return dialog state ──
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnOrder, setReturnOrder] = useState<OrderRow | null>(null);
  const [returnItemId, setReturnItemId] = useState("");

  const [query, setQuery] = useState("");
  const shownOrders = orders.filter((o) => {
    const q = query.toLowerCase();
    return (
      o.customerName.toLowerCase().includes(q) ||
      o.status.toLowerCase().includes(q) ||
      o.paymentStatus.toLowerCase().includes(q)
    );
  });

  function resetForm() {
    setItems([emptyItem()]);
    setCustomer(null);
    setHeldById(NONE);
    setStatus("PENDING");
    setDeliveryType("SELF");
    setPaymentMethod("CASH");
    setPaymentStatus("UNPAID");
    setDeliveryCharge("0");
    setDeliveryCost("");
    setPackagingCost("0");
    setGiftCost("0");
    setOrderDiscount("0");
  }

  const preview = useMemo(() => {
    const itemsSubtotal = items.reduce((s, it) => {
      const price = parseFloat(it.unitPrice) || 0;
      const qty = parseInt(it.quantity) || 0;
      const disc = parseFloat(it.discount) || 0;
      return s + price * qty - disc;
    }, 0);
    const customerTotal =
      itemsSubtotal + (parseFloat(deliveryCharge) || 0) - (parseFloat(orderDiscount) || 0);
    const costPreview =
      (parseFloat(packagingCost) || 0) +
      (parseFloat(giftCost) || 0) +
      (deliveryType === "COURIER" ? parseFloat(deliveryCost || deliveryCharge) || 0 : 0);

    return { itemsSubtotal, customerTotal, costPreview };
  }, [deliveryCharge, deliveryCost, deliveryType, giftCost, items, orderDiscount, packagingCost]);

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const cleanItems = items
      .filter((it) => it.variant && parseInt(it.quantity) > 0)
      .map((it) => ({
        productVariantId: it.variant!.value,
        unitPrice: parseFloat(it.unitPrice) || 0,
        quantity: parseInt(it.quantity) || 0,
        discount: parseFloat(it.discount) || 0,
      }));
    if (cleanItems.length === 0) {
      toast.error("Add at least one item with a product and quantity");
      return;
    }
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    fd.set("customerId", customer?.value ?? "");
    fd.set("heldByMembershipId", heldById === NONE ? "" : heldById);
    fd.set("status", status);
    fd.set("deliveryType", deliveryType);
    fd.set("paymentMethod", paymentMethod);
    fd.set("paymentStatus", paymentStatus);
    fd.set("items", JSON.stringify(cleanItems));
    const res = await createOrder(slug, fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Order created");
    setOpen(false);
    resetForm();
    router.refresh();
  }

  async function onStatusChange(orderId: string, newStatus: string) {
    const res = await updateOrderStatus(slug, orderId, newStatus);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Order → ${newStatus}`);
    router.refresh();
  }

  async function onPaymentStatusChange(orderId: string, newStatus: string) {
    const res = await updatePaymentStatus(slug, orderId, newStatus);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Payment → ${newStatus}`);
    router.refresh();
  }

  async function onDelete(orderId: string) {
    if (!confirm("Delete this order?")) return;
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Input
          placeholder="Search by customer or status…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
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

      <DataTable
        rows={shownOrders}
        rowKey={(o) => o.id}
        empty={{
          icon: ShoppingCart,
          title: "No orders found",
          description: perms.canAdd ? "Create an order to start selling." : undefined,
        }}
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
              key: "status",
              header: "Status",
              cell: (o) =>
                perms.canEdit ? (
                  <Select value={o.status} onValueChange={(v) => v && onStatusChange(o.id, v)}>
                    <SelectTrigger className="h-8 w-36">
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
                  <Badge variant="secondary">{o.status}</Badge>
                ),
            },
            {
              key: "payment",
              header: "Payment",
              cell: (o) => (
                <div className="flex items-center gap-2">
                  {perms.canEdit ? (
                    <Select
                      value={o.paymentStatus}
                      onValueChange={(v) => v && onPaymentStatusChange(o.id, v)}
                    >
                      <SelectTrigger className="h-8 w-28">
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
                    <span>{o.paymentStatus}</span>
                  )}
                  <span className="text-muted-foreground">· {o.paymentMethod}</span>
                  {o.totals.returnedUnits > 0 && (
                    <Badge variant="outline">{o.totals.returnedUnits} returned</Badge>
                  )}
                </div>
              ),
            },
            { key: "heldBy", header: "Held by", cell: (o) => o.heldByName ?? "—" },
            {
              key: "courier",
              header: "Courier ID",
              cell: (o) =>
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
            {
              key: "total",
              header: "Total",
              align: "right",
              cell: (o) => o.totals.customerTotal.toFixed(2),
            },
            ...(perms.canViewProfit
              ? [
                  {
                    key: "profit",
                    header: "Profit",
                    align: "right" as const,
                    cell: (o: OrderRow) => o.totals.netProfit.toFixed(2),
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
                        render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
                      >
                        <MoreVertical className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
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

      {/* New order dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[92dvh] max-w-[min(96vw,980px)] flex-col overflow-hidden p-0 sm:max-w-[min(96vw,980px)]">
          <DialogHeader className="shrink-0 border-b bg-muted/30 px-4 py-4 pr-14 sm:px-5">
            <DialogTitle className="text-lg">New order</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Add products first, then payment and delivery details.
            </p>
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
                      const itemTotal =
                        (parseFloat(it.unitPrice) || 0) * quantity - (parseFloat(it.discount) || 0);
                      const stockWarning =
                        selectedVariant && quantity > selectedVariant.stock
                          ? `Only ${selectedVariant.stock} in stock`
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

                          <div className="grid gap-3 lg:grid-cols-[minmax(16rem,1fr)_8rem_6rem_8rem]">
                            <div className="space-y-2 lg:col-span-1">
                              <Label>Product</Label>
                              <AsyncCombobox
                                value={it.variant}
                                onChange={(opt) => updateItem(i, { variant: opt })}
                                fetchPage={async (q, cursor) => {
                                  const res = await searchVariants(slug, q, cursor);
                                  return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                                }}
                                placeholder="Search product…"
                                renderItem={(o) => (
                                  <>
                                    <span className="truncate">{o.label}</span>
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                      {o.stock} in stock
                                    </span>
                                  </>
                                )}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Price</Label>
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
                              <Label>Qty</Label>
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
                              {stockWarning ?? "Stock will be validated before saving."}
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

                <section className="space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold">Customer and status</h3>
                    <p className="text-xs text-muted-foreground">
                      Walk-in orders can be saved without a customer profile.
                    </p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-2">
                      <Label>Customer</Label>
                      <AsyncCombobox
                        value={customer}
                        onChange={setCustomer}
                        fetchPage={async (q, cursor) => {
                          const res = await searchCustomers(slug, q, cursor);
                          return res.ok ? { items: res.items, next: res.next } : { items: [], next: null };
                        }}
                        placeholder="Walk-in — search to attach…"
                        emptyText="No customers"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="o-date">Date</Label>
                      <Input id="o-date" name="date" type="date" required defaultValue={todayInputValue()} />
                    </div>
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
                      <div className="space-y-2">
                        <Label htmlFor="o-delivery">Charge from customer</Label>
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
                      </div>
                      {deliveryType === "COURIER" && (
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
                          </div>
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
                      <div className="space-y-2">
                        <Label htmlFor="o-pack">Packaging cost</Label>
                        <Input
                          id="o-pack"
                          name="packagingCost"
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          value={packagingCost}
                          onChange={(e) => setPackagingCost(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="o-gift">Gift cost</Label>
                        <Input
                          id="o-gift"
                          name="giftCost"
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          value={giftCost}
                          onChange={(e) => setGiftCost(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2 sm:col-span-2">
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

                <div className="space-y-2">
                  <Label htmlFor="o-notes">Notes</Label>
                  <Textarea
                    id="o-notes"
                    name="notes"
                    className="min-h-20"
                    placeholder="Courier note, payment note, or special instruction"
                  />
                </div>
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
                <div className="space-y-2">
                  <Label htmlFor="r-refund">Refund amount</Label>
                  <Input id="r-refund" name="refundAmount" type="number" step="0.01" min="0" defaultValue="0" />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="r-reason">Reason</Label>
                <Input id="r-reason" name="reason" />
              </div>
              <DialogFooter>
                <Button type="submit">Record return</Button>
              </DialogFooter>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing left to return on this order.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
