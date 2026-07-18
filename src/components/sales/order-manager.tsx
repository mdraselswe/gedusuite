"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  createOrder,
  updateOrderStatus,
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
import { DataTable, type Column } from "@/components/ui/data-table";
import { ShoppingCart } from "lucide-react";

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
  paymentStatus: string;
  totals: { customerTotal: number; netProfit: number; returnedUnits: number };
  items: OrderItem[];
};
type Perms = { canAdd: boolean; canEdit: boolean; canViewProfit: boolean };
type ItemDraft = { variantId: string; unitPrice: string; quantity: string; discount: string };

const STATUSES = ["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"];
const DELIVERY = ["SELF", "COURIER"];
const METHODS = ["CASH", "BKASH", "NAGAD", "COURIER_COLLECTION", "OTHER"];
const PAY_STATUS = ["UNPAID", "PAID", "PARTIAL"];
const NONE = "__none__";

function emptyItem(): ItemDraft {
  return { variantId: "", unitPrice: "", quantity: "1", discount: "0" };
}

export function OrderManager({
  slug,
  variantOptions,
  customers,
  members,
  orders,
  perms,
}: {
  slug: string;
  variantOptions: VariantOption[];
  customers: { id: string; name: string }[];
  members: { id: string; label: string }[];
  orders: OrderRow[];
  perms: Perms;
}) {
  const router = useRouter();

  // ── New-order dialog state ──
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([emptyItem()]);
  const [customerId, setCustomerId] = useState(NONE);
  const [heldById, setHeldById] = useState(NONE);
  const [status, setStatus] = useState("PENDING");
  const [deliveryType, setDeliveryType] = useState("SELF");
  const [paymentMethod, setPaymentMethod] = useState("CASH");
  const [paymentStatus, setPaymentStatus] = useState("UNPAID");

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
    setCustomerId(NONE);
    setHeldById(NONE);
    setStatus("PENDING");
    setDeliveryType("SELF");
    setPaymentMethod("CASH");
    setPaymentStatus("UNPAID");
  }

  const preview = useMemo(() => {
    const itemsTotal = items.reduce((s, it) => {
      const price = parseFloat(it.unitPrice) || 0;
      const qty = parseInt(it.quantity) || 0;
      const disc = parseFloat(it.discount) || 0;
      return s + price * qty - disc;
    }, 0);
    return itemsTotal;
  }, [items]);

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const cleanItems = items
      .filter((it) => it.variantId && parseInt(it.quantity) > 0)
      .map((it) => ({
        productVariantId: it.variantId,
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
    fd.set("customerId", customerId === NONE ? "" : customerId);
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
                <span>
                  {o.paymentStatus}
                  {o.totals.returnedUnits > 0 && (
                    <Badge variant="outline" className="ml-2">
                      {o.totals.returnedUnits} returned
                    </Badge>
                  )}
                </span>
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
                <>
                  <Link
                    href={`/${slug}/sales/orders/${o.id}/invoice`}
                    className="inline-flex items-center text-sm underline underline-offset-4"
                  >
                    Invoice
                  </Link>
                  {perms.canEdit && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => openReturn(o)}>
                        Return
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(o.id)}>
                        Delete
                      </Button>
                    </>
                  )}
                </>
              ),
            },
          ] as Column<OrderRow>[]
        }
      />

      {/* New order dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New order</DialogTitle>
          </DialogHeader>
          {variantOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Add a product with a variant (and some stock) first.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              {/* Items */}
              <div className="space-y-2">
                <Label>Items</Label>
                {items.map((it, i) => (
                  <div key={i} className="grid grid-cols-[1fr_5rem_4rem_5rem_2rem] items-center gap-2">
                    <Select value={it.variantId} onValueChange={(v) => updateItem(i, { variantId: v ?? "" })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Product" />
                      </SelectTrigger>
                      <SelectContent>
                        {variantOptions.map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.label} · {v.stock} in stock
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Price"
                      value={it.unitPrice}
                      onChange={(e) => updateItem(i, { unitPrice: e.target.value })}
                    />
                    <Input
                      type="number"
                      min="1"
                      placeholder="Qty"
                      value={it.quantity}
                      onChange={(e) => updateItem(i, { quantity: e.target.value })}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="Disc"
                      value={it.discount}
                      onChange={(e) => updateItem(i, { discount: e.target.value })}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setItems(items.filter((_, j) => j !== i))}
                    >
                      ×
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setItems([...items, emptyItem()])}
                >
                  + Add item
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Customer</Label>
                  <Select value={customerId} onValueChange={(v) => setCustomerId(v ?? NONE)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Walk-in</SelectItem>
                      {customers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="o-date">Date</Label>
                  <Input id="o-date" name="date" type="date" required defaultValue={orders[0]?.date} />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v ?? "PENDING")}>
                    <SelectTrigger className="w-full">
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
                </div>
                <div className="space-y-2">
                  <Label>Held by (partner)</Label>
                  <Select value={heldById} onValueChange={(v) => setHeldById(v ?? NONE)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>—</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Delivery</Label>
                  <Select value={deliveryType} onValueChange={(v) => setDeliveryType(v ?? "SELF")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DELIVERY.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="o-delivery">Delivery charge</Label>
                  <Input id="o-delivery" name="deliveryCharge" type="number" step="0.01" min="0" defaultValue="0" />
                </div>
                <div className="space-y-2">
                  <Label>Payment method</Label>
                  <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v ?? "CASH")}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METHODS.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Payment status</Label>
                  <Select value={paymentStatus} onValueChange={(v) => setPaymentStatus(v ?? "UNPAID")}>
                    <SelectTrigger className="w-full">
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
                </div>
                <div className="space-y-2">
                  <Label htmlFor="o-pack">Packaging cost</Label>
                  <Input id="o-pack" name="packagingCost" type="number" step="0.01" min="0" defaultValue="0" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="o-gift">Gift cost</Label>
                  <Input id="o-gift" name="giftCost" type="number" step="0.01" min="0" defaultValue="0" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="o-disc">Order discount</Label>
                  <Input id="o-disc" name="discount" type="number" step="0.01" min="0" defaultValue="0" />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="o-notes">Notes</Label>
                <Textarea id="o-notes" name="notes" />
              </div>

              <div className="rounded-md bg-muted p-3 text-sm">
                Items subtotal (excl. order-level charges):{" "}
                <span className="font-semibold">{preview.toFixed(2)}</span>
              </div>

              <DialogFooter>
                <Button type="submit" disabled={loading}>
                  {loading ? "Saving…" : "Create order"}
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
                <Select value={returnItemId} onValueChange={(v) => setReturnItemId(v ?? "")}>
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
