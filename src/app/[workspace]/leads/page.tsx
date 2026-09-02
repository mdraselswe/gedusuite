import { redirect } from "next/navigation";
import { PhoneCall } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { LeadManager } from "@/components/leads/lead-manager";
import { dhakaInstant } from "@/lib/dhaka-time";
import { leadFulfilment } from "@/lib/lead-fulfilment";
import { normalizePhone, phoneSearchTerms } from "@/lib/phone";
import { buildBuyerHistory, historyForLead } from "@/lib/buyer-history";
import { ABANDON_AFTER_MS, CART_SOURCE } from "@/lib/abandoned-cart";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";

const PAGE_SIZE = 50;


/**
 * Call tracking for orders placed on the website. Read-only with respect to
 * the rest of the app: nothing here writes to Order, stock, treasury or the
 * reports — the real order is still entered by hand on the sales page.
 *
 * Gated on the `sales` module so rbac.ts needs no new entry. Every role has
 * at least sales:add (STAFF included), which is intended: STAFF make the calls.
 */
export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { workspace: slug } = await params;
  const sp = await searchParams;
  const page = parsePage(sp.page);
  const q = (sp.q ?? "").trim();
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "sales", "add", access.permissions),
    canDelete: can(access.role, "sales", "edit", access.permissions),
    canAddCustomer: can(access.role, "customers", "add", access.permissions),
    // Drives the "existing customer" picker in the add form — searching the
    // customer book is a customers:view action, and the server action behind
    // the box enforces that anyway, so hiding it beats offering a search that
    // always comes back empty.
    canViewCustomers: can(access.role, "customers", "view", access.permissions),
  };

  // The search reaches the database rather than the rows already on screen.
  // Somebody calls back and the number is what they give you — it has to find
  // their lead whichever page it happens to be on, which a filter over the
  // visible 50 could not do. Numbers are matched in every shape one is stored
  // in here: a lead pulled off the website keeps whatever the customer typed at
  // checkout, so "+8801712345678" and "01712345678" are both real (see
  // lib/phone).
  const phoneTerms = phoneSearchTerms(q);
  const where = {
    workspaceId: access.workspaceId,
    // A cart snapshot arrives while the customer is still typing in the
    // checkout, so the newest ones are people who are mid-purchase right now.
    // Ringing them would be worse than not ringing them at all. They stay in
    // the database — the row keeps being refreshed as they type — and appear
    // here once they have been quiet for ABANDON_AFTER_MS.
    NOT: {
      source: CART_SOURCE,
      orderedAt: { gt: new Date(Date.now() - ABANDON_AFTER_MS) },
    },
    ...(q
      ? {
          OR: [
            { customerName: { contains: q, mode: "insensitive" as const } },
            { orderNo: { contains: q, mode: "insensitive" as const } },
            { address: { contains: q, mode: "insensitive" as const } },
            { itemsText: { contains: q, mode: "insensitive" as const } },
            ...phoneTerms.flatMap((p) => [
              { phone: { contains: p } },
              // The second number is worth searching for the same reason it is
              // worth storing: it's the one that gets picked up.
              { altPhone: { contains: p } },
            ]),
          ],
        }
      : {}),
  };

  const [leadCount, totalLeadCount, leads] = await Promise.all([
    prisma.orderLead.count({ where }),
    // Unfiltered, for the bar's "showing N of M" — the list is bigger than the
    // page of it that was fetched. Carries the same cart cutoff as `where`, or
    // the total would count rows the list is deliberately not showing yet.
    prisma.orderLead.count({
      where: { workspaceId: access.workspaceId, NOT: where.NOT },
    }),
    prisma.orderLead.findMany({
      where,
      orderBy: { orderedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // Fulfilment is read off the linked orders rather than stored on the lead —
  // one query for this page's rows, not one per lead. OrderLead.orderId has no
  // foreign key, so an order deleted since linking simply isn't found, and the
  // lead reads as "Not entered" again.
  const linkedIds = leads.map((l) => l.orderId).filter((id): id is string => !!id);
  const linkedOrders = linkedIds.length
    ? await prisma.order.findMany({
        where: { id: { in: linkedIds }, workspaceId: access.workspaceId },
        select: {
          id: true,
          status: true,
          items: { select: { quantity: true, returns: { select: { quantity: true } } } },
        },
      })
    : [];
  const orderById = new Map(linkedOrders.map((o) => [o.id, o]));

  // What each number has ordered before. Two more queries for the whole page
  // rather than a lookup per row: the phones on screen, the customer records
  // they match, and those customers' orders.
  const leadPhones = [
    ...new Set(leads.map((l) => normalizePhone(l.phone)).filter((p): p is string => !!p)),
  ];
  const buyers = leadPhones.length
    ? await prisma.customer.findMany({
        where: {
          workspaceId: access.workspaceId,
          OR: [{ phone: { in: leadPhones } }, { altPhone: { in: leadPhones } }],
        },
        select: { id: true, phone: true, altPhone: true },
      })
    : [];
  const buyerOrders = buyers.length
    ? await prisma.order.findMany({
        where: { workspaceId: access.workspaceId, customerId: { in: buyers.map((b) => b.id) } },
        select: { id: true, customerId: true, status: true },
      })
    : [];
  const histories = buildBuyerHistory(buyers, buyerOrders);

  const rows = leads.map((l) => ({
    id: l.id,
    source: l.source,
    channel: l.channel,
    orderNo: l.orderNo,
    wooStatus: l.wooStatus,
    // Date and time stay separate: `date` is also the colour-grouping key and
    // what the date-range filter compares, and both need it date-only. A
    // website order carries its own placed-at time, so nothing is inferred from
    // when the row was written.
    // Carries dateInput too — what the edit form's datetime-local input needs,
    // already in Dhaka time.
    ...dhakaInstant(l.orderedAt),
    customerName: l.customerName,
    phone: l.phone,
    altPhone: l.altPhone,
    address: l.address,
    itemsText: l.itemsText,
    deliveryCharge: Number(l.deliveryCharge),
    total: Number(l.total),
    callStatus: l.callStatus as string,
    callAttempts: l.callAttempts,
    calledByName: l.calledByName,
    customerAdvice: l.customerAdvice,
    internalNote: l.internalNote,
    convertedCustomerId: l.convertedCustomerId,
    orderId: l.orderId,
    fulfilment: leadFulfilment(l.orderId ? orderById.get(l.orderId) : null),
    history: historyForLead(
      histories,
      l.phone,
      l.orderId,
      (l.orderId ? orderById.get(l.orderId)?.status : null) ?? null,
    ),
  }));

  return (
    <div className="space-y-6">
      <PageHeader icon={<PhoneCall />} color="sky" title="Call list" count={leadCount} />
      <LeadManager
        slug={slug}
        leads={rows}
        perms={perms}
        query={q}
        totalCount={totalLeadCount}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(leadCount / PAGE_SIZE)}
        basePath={`/${slug}/leads`}
        query={{ q: q || undefined }}
      />
    </div>
  );
}
