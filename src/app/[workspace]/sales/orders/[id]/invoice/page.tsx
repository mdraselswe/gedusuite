import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { DownloadInvoicePdfButton } from "@/components/invoice-actions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function vLabel(name: string, size: string | null, color: string | null) {
  const extra = [size, color].filter(Boolean).join(" / ");
  return extra ? `${name} (${extra})` : name;
}

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const [order, workspace] = await Promise.all([
    prisma.order.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: {
        customer: true,
        items: {
          include: {
            returns: true,
            productVariant: {
              select: { size: true, color: true, product: { select: { name: true } } },
            },
          },
        },
      },
    }),
    prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { name: true, logoUrl: true },
    }),
  ]);
  if (!order) notFound();

  const totals = computeOrderTotals(order);

  // If this was a courier delivery and the courier's own order number has
  // been recorded, that's what actually identifies the shipment — show it
  // instead of the internal id. Self-delivery (or no courier id yet) keeps
  // the auto-generated internal order number.
  const orderNumber =
    order.deliveryType === "COURIER" && order.courierTrackingId
      ? order.courierTrackingId
      : order.id.slice(-8).toUpperCase();

  return (
    <div className="mx-auto max-w-2xl space-y-6 print:max-w-full">
      <div className="flex items-center justify-between print:hidden">
        <Link href={`/${slug}/sales/orders`} className="text-sm text-muted-foreground underline">
          ← Orders
        </Link>
        <DownloadInvoicePdfButton targetId="invoice-print-area" filename={`invoice-${orderNumber}`} />
      </div>

      <div id="invoice-print-area" className="rounded-lg border p-8 print:border-0 print:p-0">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {workspace?.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={workspace.logoUrl} alt={workspace.name} className="h-10 w-auto max-w-28 object-contain" />
            )}
            <div>
              <h1 className="text-2xl font-bold text-primary">{workspace?.name}</h1>
              <p className="text-sm text-muted-foreground">Invoice</p>
            </div>
          </div>
          <div className="text-right text-sm">
            <div>#{orderNumber}</div>
            <div className="text-muted-foreground">{order.date.toISOString().slice(0, 10)}</div>
            <div className="text-muted-foreground">{order.status}</div>
          </div>
        </div>

        <div className="mt-6 text-sm">
          <div className="font-semibold">Bill to</div>
          <div>{order.customer?.name ?? "Walk-in customer"}</div>
          {order.customer?.phone && <div>{order.customer.phone}</div>}
          {order.customer?.address && <div>{order.customer.address}</div>}
        </div>

        <div className="mt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((it) => {
                const returned = it.returns.reduce((s, r) => s + r.quantity, 0);
                const eq = it.quantity - returned;
                return (
                  <TableRow key={it.id}>
                    <TableCell>
                      {vLabel(it.productVariant.product.name, it.productVariant.size, it.productVariant.color)}
                      {returned > 0 && (
                        <span className="text-xs text-muted-foreground"> ({returned} returned)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{eq}</TableCell>
                    <TableCell className="text-right">{Number(it.unitPrice).toFixed(2)}</TableCell>
                    <TableCell className="text-right">
                      {(Number(it.unitPrice) * eq).toFixed(2)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="mt-6 ml-auto max-w-xs space-y-1 text-sm">
          <Row label="Item discounts" value={-totals.itemDiscounts} />
          <Row label="Order discount" value={-totals.orderDiscount} />
          {/* Delivery always shows — a zero/absent charge prints as "Free". */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Delivery</span>
            <span>{totals.deliveryCharge > 0 ? totals.deliveryCharge.toFixed(2) : "Free"}</span>
          </div>
          <div className="flex justify-between border-t pt-2 text-base font-bold">
            <span>Total</span>
            <span>{totals.customerTotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Payment</span>
            <span>
              {order.paymentStatus} · {order.paymentMethod}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  if (!value) return null;
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value.toFixed(2)}</span>
    </div>
  );
}
