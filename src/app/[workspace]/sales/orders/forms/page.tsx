import Link from "next/link";
import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals, invoiceNumber } from "@/lib/orders";
import { amountCollected, amountOutstanding } from "@/lib/order-cash";
import { orderRecipient } from "@/lib/order-recipient";
import { PrintSheetView } from "@/components/ui/print-sheet-view";
import { OrderFormSlip, type SlipOrder } from "@/components/sales/order-form-slip";
import { variantFullName } from "@/lib/variants";
import { EmptyState } from "@/components/ui/empty-state";
import { Printer } from "lucide-react";

/**
 * Printable delivery/order forms, two or four to an A4 landscape sheet
 * (`?perPage=`, chosen on the orders list before printing).
 *
 * Fewer sheets per run is the whole point: an A4 cut down the middle is two
 * A5 forms, or into quarters four smaller ones, so a run of orders costs a
 * fraction of the paper it used to. Selecting a count that doesn't divide
 * evenly is fine and deliberate — the last sheet's remaining slots print as
 * blank forms to fill in by hand.
 *
 * `?blank=1` skips the order lookup entirely and renders one sheet's worth of
 * nothing but blank forms — a paper copy for the packing table, wanted for
 * exactly the situations where there's no order in the system yet to select.
 */

/**
 * 40 orders = 20 sheets = 20 full-page canvas captures in the browser. Past
 * roughly this the tab spends a long time unresponsive and the PDF gets large
 * enough to be awkward to send, so the list is capped and the user is told
 * rather than left watching a frozen page.
 */
const MAX_ORDERS = 40;

/**
 * Printed dates are read in Dhaka, so they're formatted in Dhaka. Taking the
 * date off the raw UTC timestamp instead would print yesterday for every order
 * placed after 6pm local, which is most of an evening's trading.
 */
const printDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dhaka",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Which of the two printed boxes to tick, from the courier zone's name. Shop
 * zones are named "Dhaka City" / "Outside Dhaka" (see CourierZone), but the
 * name is free text, so anything unrecognised leaves BOTH boxes blank for
 * someone to tick by hand. Guessing wrong here sends a parcel to the wrong
 * rate; printing nothing just asks a question.
 */
function insideDhakaFromZone(zoneName: string | null | undefined): boolean | null {
  if (!zoneName) return null;
  const n = zoneName.toLowerCase();
  if (n.includes("outside") || n.includes("বাইরে")) return false;
  if (n.includes("dhaka") || n.includes("ঢাকা")) return true;
  return null;
}

/**
 * COD vs বিকাশ/নগদ. CASH counts as COD — money handed over when the parcel
 * arrives is what the box means, whether a courier or a member collects it.
 * OTHER maps to neither and prints blank.
 */
function codFromMethod(method: string): boolean | null {
  if (method === "BKASH" || method === "NAGAD") return false;
  if (method === "CASH" || method === "COURIER_COLLECTION") return true;
  return null;
}

export default async function OrderFormsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ ids?: string; perPage?: string; blank?: string }>;
}) {
  const { workspace: slug } = await params;
  const { ids: idsParam, perPage: perPageParam, blank: blankParam } = await searchParams;
  // Only 2 and 4 are laid out for; anything else (a hand-edited URL) falls
  // back to the original two-to-a-sheet form rather than rendering nothing.
  const density: 2 | 4 = perPageParam === "4" ? 4 : 2;
  const isBlank = blankParam === "1";

  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  // A blank run names no orders, so there's nothing to look up.
  const requestedIds = isBlank
    ? []
    : [...new Set((idsParam ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  const ids = requestedIds.slice(0, MAX_ORDERS);

  const [orders, workspace] = await Promise.all([
    ids.length
      ? prisma.order.findMany({
          // workspaceId is part of the filter, not a check afterwards: an id
          // pasted in from another workspace has to return nothing, not a
          // form with somebody else's customer on it.
          where: { id: { in: ids }, workspaceId: access.workspaceId },
          include: {
            customer: true,
            courierZone: { select: { name: true } },
            items: {
              include: {
                returns: true,
                productVariant: {
                  select: { attributes: true, product: { select: { name: true } } },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    prisma.workspace.findUnique({
      where: { id: access.workspaceId },
      select: { name: true, logoUrl: true, websiteUrl: true },
    }),
  ]);

  // Print in the order they were selected in, which is the order they were
  // read off the list — findMany gives no ordering guarantee of its own.
  const byId = new Map(orders.map((o) => [o.id, o]));
  const slips: SlipOrder[] = ids
    .map((id) => byId.get(id))
    .filter((o) => o != null)
    .map((order) => {
      const totals = computeOrderTotals(order);
      // Fully-returned lines are dropped rather than printed as "×0": the
      // packer is reading a list of what goes in the box.
      const items = order.items
        .map((item) => ({
          name: variantFullName(item.productVariant.product.name, item.productVariant.attributes),
          qty: item.quantity - item.returns.reduce((s, r) => s + r.quantity, 0),
        }))
        .filter((it) => it.qty > 0);
      const totalQty = items.reduce((sum, it) => sum + it.qty, 0);
      const to = orderRecipient(order);
      return {
        orderNumber: invoiceNumber(order),
        dateLabel: printDate.format(order.date),
        // The address this parcel was actually agreed for. A repeat buyer
        // ordering to a new address would otherwise be sent to their old one.
        customerName: to.name,
        phone: to.phone,
        address: to.address,
        items,
        totalQty,
        // What the courier hands back, not what the order was worth: an order
        // already settled by bKash collects nothing, and a part-paid one
        // collects only the balance. Printing customerTotal on either is how
        // the same money gets taken twice.
        collect: amountOutstanding(order, totals),
        total: totals.customerTotal,
        paid: amountCollected(order, totals),
        cancelled: order.status === "CANCELLED",
        insideDhaka: insideDhakaFromZone(order.courierZone?.name),
        codPayment: codFromMethod(order.paymentMethod),
        notes: order.notes,
      };
    });

  const ws = {
    name: workspace?.name ?? "",
    logoUrl: workspace?.logoUrl ?? null,
    websiteUrl: workspace?.websiteUrl ?? null,
  };

  // `density` to a sheet, with nulls filling out the last sheet's remaining
  // slots when the count doesn't divide evenly. A blank run is one sheet of
  // nothing but those nulls — there's no order to chunk.
  const sheets: (SlipOrder | null)[][] = isBlank
    ? [Array.from({ length: density }, () => null)]
    : [];
  for (let i = 0; i < slips.length; i += density) {
    const sheet: (SlipOrder | null)[] = [];
    for (let j = 0; j < density; j++) sheet.push(slips[i + j] ?? null);
    sheets.push(sheet);
  }

  const filename = isBlank
    ? `blank-order-form-${density}up`
    : slips.length === 1
      ? `order-form-${slips[0].orderNumber}`
      : `order-forms-${slips.length}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/${slug}/sales/orders`} className="text-sm text-muted-foreground underline">
          ← Orders
        </Link>
        <div className="text-sm text-muted-foreground">
          {isBlank ? (
            <>
              Blank form ({density}/page) · {sheets.length} A4 sheet{sheets.length === 1 ? "" : "s"}
            </>
          ) : (
            <>
              {slips.length} order{slips.length === 1 ? "" : "s"} · {sheets.length} A4 sheet
              {sheets.length === 1 ? "" : "s"}
            </>
          )}
          {requestedIds.length > ids.length && (
            <span className="ml-2 text-destructive">
              (showing the first {MAX_ORDERS} of {requestedIds.length})
            </span>
          )}
        </div>
      </div>

      {sheets.length === 0 ? (
        <EmptyState
          icon={Printer}
          title="No orders to print"
          description="Select one or more orders from the list, then choose Print order forms."
        />
      ) : (
        <PrintSheetView filename={filename}>
          {sheets.map((slots, i) => (
            <div key={i} data-sheet-frame>
              <div data-sheet data-density={density}>
                {slots.map((order, j) => (
                  <div key={j} data-slot>
                    <OrderFormSlip order={order} workspace={ws} density={density} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </PrintSheetView>
      )}
    </div>
  );
}
