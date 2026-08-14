import Link from "next/link";
import { redirect } from "next/navigation";
import { Truck } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { codCollectable, deliveryCostCharged } from "@/lib/order-cash";
import { expectedCourierBalance } from "@/lib/courier";
import { loadCourierCredentials } from "@/lib/courier-credentials";
import { getBalance } from "@/lib/steadfast";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { CourierReconciliation, type CourierAccount } from "@/components/sales/courier-reconciliation";
import { dhakaRecordStamp } from "@/lib/dhaka-time";

/**
 * What each courier is holding.
 *
 * The courier's own app shows a balance; this shows what it *should* be from
 * the orders, so the two can be put side by side. When they disagree, the gap
 * is a parcel priced differently from the rules — or a charge nobody knew
 * about, which is exactly how an unexplained 82 taka goes unnoticed for
 * months.
 *
 * Only delivered-and-unpaid orders count. A parcel still in transit has
 * collected nothing, so it is listed separately rather than mixed in.
 */
export default async function CouriersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }
  const workspaceId = access.workspaceId;

  const orders = await prisma.order.findMany({
    where: {
      workspaceId,
      deliveryType: "COURIER",
      // "Cash deposited" is the only mark that means the money actually
      // reached the business. Payment status can't be used: an order goes PAID
      // the moment the customer hands cash to the rider, which is precisely
      // when the courier — not the shop — is holding it.
      cashInTreasury: false,
      OR: [
        { status: { not: "CANCELLED" } },
        // A partial delivery: the customer paid the shipping and refused the
        // goods, and that money sits with the courier like any other
        // collection. Dropping those rows leaves a gap in the balance that can
        // never be explained.
        { status: "CANCELLED", cancelledCollected: { gt: 0 } },
        // A parcel that came back with nothing collected. It holds no money of
        // yours, but the courier still charged for the trip and takes that off
        // the next payout, so it belongs in the balance as a minus — leaving
        // it out is what made this page read 115 taka higher than Steadfast's
        // own figure. `gt: 0` skips a null cost, which means "no bill was ever
        // recorded", the same rule deliveryCostCharged applies. This is the OR
        // that finance.ts's paidNotDeposited already had; the two pages
        // disagreed while only one of them knew about returns.
        { status: "CANCELLED", deliveryCost: { gt: 0 } },
      ],
    },
    orderBy: { date: "asc" },
    include: {
      customer: { select: { name: true } },
      courier: { select: { id: true, name: true } },
      items: { include: { returns: true } },
    },
  });

  const couriers = await prisma.courier.findMany({
    where: { workspaceId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      codFeePercent: true,
      codFeeBase: true,
      apiKeyEnc: true,
    },
  });

  // What each connected courier says it is holding, right now. Asked here so
  // the comparison is a fact on the page rather than a number somebody has to
  // fetch from another app and retype — that retyping is the step that gets
  // skipped, and a reconciliation nobody performs is not one.
  //
  // A courier that cannot be reached leaves this null and the box goes back to
  // being typed in. A balance page that fails to render because a third party
  // is down would be a worse trade than a missing convenience.
  const liveBalances = new Map<string, number>();
  await Promise.all(
    couriers
      .filter((c) => c.apiKeyEnc)
      .map(async (c) => {
        const creds = await loadCourierCredentials(c.id);
        if (!creds) return;
        const res = await getBalance(creds);
        if (res.ok) liveBalances.set(c.id, Number(res.data.current_balance));
      }),
  );

  const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  const UNASSIGNED = "__none__";
  const accounts = new Map<string, CourierAccount>();
  const account = (id: string, name: string) => {
    const existing = accounts.get(id);
    if (existing) return existing;
    const fresh: CourierAccount = {
      id,
      name,
      apiConnected: couriers.some((c) => c.id === id && !!c.apiKeyEnc),
      liveBalance: liveBalances.get(id) ?? null,
      holding: [],
      inTransit: [],
      expected: 0,
      inTransitValue: 0,
    };
    accounts.set(id, fresh);
    return fresh;
  };
  for (const c of couriers) account(c.id, c.name);

  for (const o of orders) {
    const t = computeOrderTotals(o);
    const cancelled = o.status === "CANCELLED";
    // What the courier's own ledger has against this parcel. A cancelled one
    // collected only what the customer actually handed over; a delivered one
    // collected the invoice, less anything that went missing before it reached
    // the courier's app — a rider who banked 900 against a 960 invoice leaves
    // this page expecting 60 the courier is never going to remit.
    // Through codCollectable, like every other surface that asks what the
    // courier is holding. A parcel can travel by courier and still have been
    // paid in advance — bKash or cash up front, then shipped — and the courier
    // collects nothing on those. Read as a collection, each one added its whole
    // invoice to a balance the courier never held, on the page whose only job
    // is to be compared against the courier's own figure. The delivery charge
    // still counts: the trip was made and gets billed either way, so a prepaid
    // parcel is a minus here rather than a plus.
    const cod = codCollectable(
      o.paymentMethod,
      cancelled ? Number(o.cancelledCollected) : t.invoicedTotal - t.collectionShortfall,
    );
    // Shared with depositAmount rather than re-derived: a cancellation with no
    // courier charge recorded owes nothing for the trip, and this page saying
    // otherwise would put the balance out by a bill the courier never sent.
    const deliveryCost = deliveryCostCharged(o, t);
    const acc = account(o.courier?.id ?? UNASSIGNED, o.courier?.name ?? "No courier set");
    const row = {
      id: o.id,
      ...dhakaRecordStamp(o.date, o.createdAt, o.dateHasTime),
      customerName: o.customer?.name ?? "Walk-in",
      trackingId: o.courierTrackingId,
      status: o.status as string,
      courierStatus: o.courierStatus,
      cod,
      // What the invoice said, so the row can show the pair rather than a
      // figure that quietly disagrees with the order behind it.
      invoiced: t.customerTotal,
      shortfall: t.collectionShortfall,
      shortfallNote: o.collectionNote,
      deliveryCost,
      codFee: t.codFeeCost,
      // Not floored at zero, unlike a treasury deposit: a parcel that cost more
      // to bring back than it collected means the shop owes the courier, and a
      // balance has to be able to say so.
      net: Math.round((cod - deliveryCost - t.codFeeCost + Number.EPSILON) * 100) / 100,
    };
    // Money is only with the courier once it has actually been collected —
    // which a delivered parcel has, and a partly-delivered one has too.
    if (o.status === "DELIVERED" || cancelled) {
      acc.holding.push(row);
    } else {
      acc.inTransit.push(row);
      acc.inTransitValue += row.cod;
    }
  }

  // The percentage fee is charged on the payout, not on each parcel, so the
  // balance is worked out over the whole set — see expectedCourierBalance.
  // Summing the rows' own "You get" figures instead is what left this page
  // reading 1.35 under the courier's own app.
  const feeRules = new Map(
    couriers.map((c) => [
      c.id,
      { codFeePercent: Number(c.codFeePercent), codFeeBase: c.codFeeBase },
    ]),
  );
  const rows = [...accounts.values()]
    .map((a) => ({
      ...a,
      expected: expectedCourierBalance(
        a.holding.map((p) => ({ codAmount: p.cod, deliveryCost: p.deliveryCost })),
        feeRules.get(a.id),
      ),
      inTransitValue: round2(a.inTransitValue),
    }))
    .filter((a) => a.holding.length > 0 || a.inTransit.length > 0 || a.id !== UNASSIGNED);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Truck />}
        color="violet"
        title="Courier balance"
        action={
          <Link
            href={`/${slug}/settings/couriers`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Rates &amp; rules
          </Link>
        }
      />
      <CourierReconciliation
        slug={slug}
        accounts={rows}
        canEdit={can(access.role, "sales", "edit", access.permissions)}
      />
    </div>
  );
}
