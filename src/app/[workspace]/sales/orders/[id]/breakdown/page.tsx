import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { cancelledOrderCost, computeOrderTotals } from "@/lib/orders";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { variantFullName } from "@/lib/variants";
import { Money } from "@/components/ui/money";
import { RecordHistory } from "@/components/activity/record-history";
import { ParcelJourney } from "@/components/sales/parcel-journey";
import { formatMoney as money } from "@/lib/money";
import { dhakaRecordStamp } from "@/lib/dhaka-time";
import { Stamp } from "@/components/ui/stamp";

export default async function OrderBreakdownPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  // Cost/profit is sensitive — gate on the same "reports" access that
  // controls whether the Profit column shows on the orders list at all.
  if (!can(access.role, "reports", "view", access.permissions)) {
    redirect(`/${slug}/sales/orders`);
  }

  const [order, comboSets] = await Promise.all([
    prisma.order.findFirst({
    where: { id, workspaceId: access.workspaceId },
    include: {
      customer: true,
      heldBy: { include: { user: { select: { name: true, email: true } } } },
      items: {
        include: {
          returns: true,
          productVariant: {
            select: { attributes: true, product: { select: { name: true } } },
          },
        },
      },
      gifts: true,
    },
    }),
    // The lines hold a combo id and nothing else, so a name has to be fetched
    // to say which combo a discounted line belongs to.
    prisma.comboSet.findMany({
      where: { workspaceId: access.workspaceId },
      select: { id: true, name: true },
    }),
  ]);
  if (!order) notFound();

  const comboNames = new Map(comboSets.map((c) => [c.id, c.name]));

  const totals = computeOrderTotals(order);
  const deliveryCostWasBlank = order.deliveryCost == null;
  // A cancelled order sold nothing and its stock went back on the shelf, so
  // the sold-order calculation below describes a sale that never happened.
  // What it actually left behind is its own, much shorter, sum.
  const cancelled = order.status === "CANCELLED";
  const cancelCost = cancelledOrderCost(order);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link href={`/${slug}/sales/orders`} className="text-sm text-muted-foreground underline">
          ← Orders
        </Link>
        <Link
          href={`/${slug}/sales/orders/${order.id}/invoice`}
          className="text-sm underline underline-offset-4"
        >
          View invoice
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Order calculation breakdown</h1>
        <p className="text-sm text-muted-foreground">
          {order.isGiveaway && (
            <span className="mr-1 rounded border border-violet-500/60 px-1.5 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-400">
              Free giveaway
            </span>
          )}
          #{order.id.slice(-8).toUpperCase()} ·{" "}
          <Stamp {...dhakaRecordStamp(order.date, order.createdAt, order.dateHasTime)} /> ·{" "}
          {order.customer?.name ?? "Walk-in customer"}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {cancelled ? "Items (cancelled — went back on the shelf, not sold)" : "Items"}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Returned</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Unit cost</TableHead>
                <TableHead className="text-right">Line discount</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">COGS</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((it) => {
                const returned = it.returns.reduce((s, r) => s + r.quantity, 0);
                const eq = Math.max(0, it.quantity - returned);
                const lineRevenue = Number(it.unitPrice) * eq;
                const lineCogs = Number(it.unitCost) * eq;
                return (
                  <TableRow key={it.id}>
                    <TableCell>
                      {variantFullName(it.productVariant.product.name, it.productVariant.attributes)}
                      {/* Deliberately still one row per component: this page
                          exists to show what each piece cost and earned, which
                          a folded-up combo would hide. What it owes the reader
                          is why the discount is there. */}
                      {it.comboSetId && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          part of {comboNames.get(it.comboSetId) ?? "a combo"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{it.quantity}</TableCell>
                    <TableCell className="text-right">{returned || "—"}</TableCell>
                    <TableCell className="text-right"><Money value={Number(it.unitPrice)} /></TableCell>
                    <TableCell className="text-right"><Money value={Number(it.unitCost)} /></TableCell>
                    <TableCell className="text-right"><Money value={Number(it.discount)} /></TableCell>
                    <TableCell className="text-right"><Money value={lineRevenue} /></TableCell>
                    <TableCell className="text-right"><Money value={lineCogs} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {order.gifts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Gifts (not on the customer invoice)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Gift</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  <TableHead className="text-right">Total cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.gifts.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      {g.label}
                      {!g.productVariantId && (
                        <span className="ml-2 text-xs text-muted-foreground">(custom)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{g.quantity}</TableCell>
                    <TableCell className="text-right"><Money value={Number(g.unitCost)} /></TableCell>
                    <TableCell className="text-right">
                      <Money value={(Number(g.unitCost) * g.quantity)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {cancelled ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Cancellation result</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Collected from customer (partial delivery)" value={cancelCost.collected} />
            <Row label="Courier's charge for the failed trip" value={-cancelCost.deliveryCost} />
            <Row label="Courier's fee on what it collected" value={-cancelCost.codFeeCost} />
            <Row label="Gift cost (gone with the parcel)" value={-cancelCost.giftCost} />
            <div className="flex justify-between border-t pt-2 text-base font-bold">
              <span>Net effect on profit</span>
              <span><Money value={-cancelCost.total} /></span>
            </div>
            <p className="pt-3 text-xs text-muted-foreground">
              Nothing was sold, so there is no revenue and no COGS — the stock went back on the
              shelf. The margin this order would have earned if it had been delivered (
              {money(totals.netProfit)}) is not counted anywhere.
            </p>
            {cancelCost.packagingCost > 0 && (
              <p className="text-xs text-muted-foreground">
                Packaging used: {money(cancelCost.packagingCost)} — recorded, but not subtracted
                here. The material was charged to profit when it was bought, so taking it again
                per order would count the same polybags twice.
              </p>
            )}
            {deliveryCostWasBlank && (
              <p className="pt-1 text-xs text-amber-600 dark:text-amber-400">
                No courier charge was entered when this order was cancelled, so it is treated as
                zero. If the courier billed for the return, edit the order to set the delivery
                cost and this figure will update.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Full calculation</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Gross revenue (before returns)" value={totals.grossRevenue} />
            <Row label="Item discounts" value={-totals.itemDiscounts} />
            <Row label="Order discount" value={-totals.orderDiscount} />
            <Row label="= Net revenue" value={totals.netRevenue} bold />
            <div className="h-2" />
            <Row label="COGS (cost of goods sold)" value={-totals.cogs} />
            {/* Packaging is deliberately NOT here. It is expensed when the bags
                are bought, as an internal purchase, so charging a per-order
                share as well would put the same money through the accounts
                twice — see the note on OrderTotals.packagingCost. It used to
                sit in this column as a minus, which left these rows short of
                the bold figure underneath by exactly the packaging. It is
                reported below the total instead. */}
            <Row label="Gift cost" value={-totals.giftCost} />
            <Row
              label={`Delivery margin (charge ${money(totals.deliveryCharge)} − cost ${money(totals.deliveryCost)})`}
              value={totals.deliveryMargin}
            />
            {/* Both of these were already inside net profit; only the total
                said so, which left the rows above it not adding up to the
                figure underneath. */}
            {totals.codFeeCost > 0 && (
              <Row label="Courier's fee on what it collected" value={-totals.codFeeCost} />
            )}
            {totals.collectionShortfall > 0 && (
              <Row
                label="Collected short (never reached the business)"
                value={-totals.collectionShortfall}
              />
            )}
            <div className="flex justify-between border-t pt-2 text-base font-bold">
              <span>Net profit</span>
              <span><Money value={totals.netProfit} /></span>
            </div>
            {totals.packagingCost > 0 && (
              <p className="pt-2 text-xs text-muted-foreground">
                Packaging used: {money(totals.packagingCost)} — recorded, but not subtracted
                above. The material was charged to profit when it was bought, so taking it again
                per order would count the same polybags twice.
              </p>
            )}
            <div className="h-2" />
            <Row label="Delivery charge (billed to customer)" value={totals.deliveryCharge} />
            <div className="flex justify-between border-t pt-2 text-base font-bold">
              <span>Customer total</span>
              <span><Money value={totals.customerTotal} /></span>
            </div>
            {totals.refunds > 0 && <Row label="Refunded to customer" value={-totals.refunds} />}
            {totals.returnedUnits > 0 && (
              <div className="pt-1 text-muted-foreground">{totals.returnedUnits} unit(s) returned</div>
            )}
            {deliveryCostWasBlank && (
              <p className="pt-3 text-xs text-amber-600 dark:text-amber-400">
                Delivery cost was never entered for this order — assumed equal to delivery charge
                (0 margin). If the actual courier cost was different, edit the order to set it and
                profit will update.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <Row label="Order status" value={order.status} />
          <Row
            label="Payment"
            value={`${order.paymentStatus} · ${order.paymentMethod}`}
          />
          <Row label="Held by" value={order.heldBy ? (order.heldBy.user.name ?? order.heldBy.user.email) : "—"} />
          <Row label="Cash in treasury" value={order.cashInTreasury ? "Yes" : "No"} />
        </CardContent>
      </Card>

      {/* Where the parcel got to, before why the figures are what they are.
          Two questions, and the one asked with a customer on the phone is the
          one that should not need reading twelve rows to answer. */}
      <ParcelJourney workspaceId={access.workspaceId} orderId={order.id} />

      {/* Why this order's figures are what they are — who changed what, when.
          Renders nothing when nobody has touched it since the audit trail
          started, so older orders don't grow an empty card. */}
      <RecordHistory
        workspaceId={access.workspaceId}
        entity="Order"
        entityId={order.id}
        title="Change history"
      />
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: number | string;
  bold?: boolean;
}) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span>{typeof value === "number" ? <Money value={value} /> : value}</span>
    </div>
  );
}
