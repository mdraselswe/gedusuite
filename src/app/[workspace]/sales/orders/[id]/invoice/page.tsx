import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals, invoiceNumber } from "@/lib/orders";
import { orderRecipient } from "@/lib/order-recipient";
import { amountCollected, amountOutstanding } from "@/lib/order-cash";
import { DownloadInvoicePdfButton } from "@/components/invoice-actions";
import { variantFullName } from "@/lib/variants";
import { groupComboLines } from "@/lib/combo-lines";
import { round2 } from "@/lib/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Money } from "@/components/ui/money";
import { dhakaRecordStamp } from "@/lib/dhaka-time";
import { Stamp } from "@/components/ui/stamp";

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

  const [order, workspace, comboSets] = await Promise.all([
    prisma.order.findFirst({
      where: { id, workspaceId: access.workspaceId },
      include: {
        customer: true,
        items: {
          include: {
            returns: true,
            productVariant: {
              select: { attributes: true, product: { select: { name: true } } },
            },
          },
        },
      },
    }),
    prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { name: true, logoUrl: true },
    }),
    // Names for whatever combos this order sold. The lines carry only an id —
    // deliberately, so deleting a recipe can never take an order's history
    // with it — which leaves the name to be looked up when one is printed.
    prisma.comboSet.findMany({
      where: { workspaceId: access.workspaceId },
      select: { id: true, name: true },
    }),
  ]);
  if (!order) notFound();

  const totals = computeOrderTotals(order);

  // A combo was sold as one price and is printed as one price. Its components
  // reach the database separately because that is what stock and returns need;
  // an invoice that reprinted them as 900 + 650 less 350 would be telling the
  // customer the same arithmetic the hard way.
  const { groups, comboDiscount } = groupComboLines(
    order.items.map((it) => ({
      id: it.id,
      quantity: it.quantity,
      unitPrice: Number(it.unitPrice),
      discount: Number(it.discount),
      comboSetId: it.comboSetId,
      comboKey: it.comboKey,
      label: variantFullName(it.productVariant.product.name, it.productVariant.attributes),
      returned: it.returns.reduce((s, r) => s + r.quantity, 0),
    })),
    new Map(comboSets.map((c) => [c.id, c.name])),
  );
  // The saving is already inside each combo's printed price, so the discount
  // line below must not claim it again.
  const looseItemDiscounts = round2(Math.max(0, totals.itemDiscounts - comboDiscount));

  const orderNumber = invoiceNumber(order);
  // What this order was addressed to, not what the customer record says now.
  const to = orderRecipient(order);

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
            <div className="text-muted-foreground">
              <Stamp {...dhakaRecordStamp(order.date, order.createdAt, order.dateHasTime)} />
            </div>
            <div className="text-muted-foreground">{order.status}</div>
            {/* On the customer's own copy too: a 0 total with no word for it
                looks like a billing mistake. */}
            {order.isGiveaway && <div className="font-medium">Free of charge</div>}
          </div>
        </div>

        <div className="mt-6 text-sm">
          <div className="font-semibold">Bill to</div>
          <div>{to.name ?? "Walk-in customer"}</div>
          {to.phone && <div>{to.phone}</div>}
          {to.address && <div>{to.address}</div>}
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
              {groups.map((g) => {
                if (g.kind === "combo") {
                  return (
                    <TableRow key={g.comboSetId}>
                      <TableCell className="whitespace-normal wrap-break-word">
                        <span className="font-medium">{g.name}</span>
                        {g.returned > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            ({g.returned} returned)
                          </span>
                        )}
                        {/* What is in the box, so the customer can check the
                            parcel against the invoice without knowing what a
                            combo contains. */}
                        <ul className="mt-0.5 text-xs text-muted-foreground">
                          {g.lines.map((l) => (
                            <li key={l.id}>
                              {l.label} ×{Math.max(0, l.quantity - l.returned)}
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell className="text-right">{g.sets}</TableCell>
                      <TableCell className="text-right">
                        <Money value={g.sets > 0 ? round2(g.net / g.sets) : 0} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Money value={g.net} />
                      </TableCell>
                    </TableRow>
                  );
                }
                const it = g.line;
                const eq = it.quantity - it.returned;
                return (
                  <TableRow key={it.id}>
                    {/* Long product names wrap instead of forcing the table
                        wider than the invoice (which cropped/scrolled). */}
                    <TableCell className="whitespace-normal wrap-break-word">
                      {it.label}
                      {it.returned > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          ({it.returned} returned)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{eq}</TableCell>
                    <TableCell className="text-right">
                      <Money value={it.unitPrice} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Money value={round2(it.unitPrice * eq)} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="mt-6 ml-auto max-w-xs space-y-1 text-sm">
          <Row label="Item discounts" value={-looseItemDiscounts} />
          <Row label="Order discount" value={-totals.orderDiscount} />
          {/* Delivery always shows — a zero/absent charge prints as "Free". */}
          <div className="flex justify-between">
            <span className="text-muted-foreground">Delivery</span>
            <span>{totals.deliveryCharge > 0 ? <Money value={totals.deliveryCharge} /> : "Free"}</span>
          </div>
          <div className="flex justify-between border-t pt-2 text-base font-bold">
            <span>Total</span>
            <span><Money value={totals.customerTotal} /></span>
          </div>
          {/* A part-paid invoice that shows only the total is the one document
              most likely to be argued over. Print what was paid and what is
              left, so the customer and the shop read the same figure. */}
          {order.paymentStatus === "PARTIAL" && Number(order.amountPaid) > 0 && (
            <>
              <Row label="Paid" value={amountCollected(order, totals)} />
              <div className="flex justify-between font-medium">
                <span>Balance due</span>
                <span><Money value={amountOutstanding(order, totals)} /></span>
              </div>
            </>
          )}
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
      <span><Money value={value} /></span>
    </div>
  );
}
