import Link from "next/link";
import { redirect } from "next/navigation";
import { Truck } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { deliveryCostCharged } from "@/lib/order-cash";
import { PageHeader } from "@/components/ui/page-header";
import { buttonVariants } from "@/components/ui/button";
import { CourierReconciliation, type CourierAccount } from "@/components/sales/courier-reconciliation";

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
      // A cancelled parcel usually holds nothing — but a partial delivery
      // does: the customer paid the shipping and refused the goods, and that
      // money sits with the courier like any other collection. Dropping those
      // rows leaves a gap in the balance that can never be explained.
      OR: [{ status: { not: "CANCELLED" } }, { cancelledCollected: { gt: 0 } }],
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
    select: { id: true, name: true },
  });

  const UNASSIGNED = "__none__";
  const accounts = new Map<string, CourierAccount>();
  const account = (id: string, name: string) => {
    const existing = accounts.get(id);
    if (existing) return existing;
    const fresh: CourierAccount = { id, name, holding: [], inTransit: [], expected: 0, inTransitValue: 0 };
    accounts.set(id, fresh);
    return fresh;
  };
  for (const c of couriers) account(c.id, c.name);

  for (const o of orders) {
    const t = computeOrderTotals(o);
    const cancelled = o.status === "CANCELLED";
    // A cancelled parcel collected only what the customer actually handed
    // over; its order total was never charged.
    const cod = cancelled ? Number(o.cancelledCollected) : t.customerTotal;
    // Shared with depositAmount rather than re-derived: a cancellation with no
    // courier charge recorded owes nothing for the trip, and this page saying
    // otherwise would put the balance out by a bill the courier never sent.
    const deliveryCost = deliveryCostCharged(o, t);
    const acc = account(o.courier?.id ?? UNASSIGNED, o.courier?.name ?? "No courier set");
    const row = {
      id: o.id,
      date: o.date.toISOString().slice(0, 10),
      customerName: o.customer?.name ?? "Walk-in",
      trackingId: o.courierTrackingId,
      status: o.status as string,
      cod,
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
      acc.expected += row.net;
    } else {
      acc.inTransit.push(row);
      acc.inTransitValue += row.cod;
    }
  }

  const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  const rows = [...accounts.values()]
    .map((a) => ({ ...a, expected: round2(a.expected), inTransitValue: round2(a.inTransitValue) }))
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
      <CourierReconciliation slug={slug} accounts={rows} />
    </div>
  );
}
