import { redirect } from "next/navigation";
import { PhoneCall } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { LeadManager } from "@/components/leads/lead-manager";
import { formatDhakaDate, formatDhakaTime, toDhakaInputValue } from "@/lib/dhaka-time";
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
  searchParams: Promise<{ page?: string }>;
}) {
  const { workspace: slug } = await params;
  const page = parsePage((await searchParams).page);
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "sales", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "sales", "add", access.permissions),
    canDelete: can(access.role, "sales", "edit", access.permissions),
    canAddCustomer: can(access.role, "customers", "add", access.permissions),
  };

  const [leadCount, leads] = await Promise.all([
    prisma.orderLead.count({ where: { workspaceId: access.workspaceId } }),
    prisma.orderLead.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { orderedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const rows = leads.map((l) => ({
    id: l.id,
    source: l.source,
    channel: l.channel,
    orderNo: l.orderNo,
    wooStatus: l.wooStatus,
    // Date and time stay separate: `date` is also the colour-grouping key and
    // what the date-range filter compares, and both need it date-only.
    date: formatDhakaDate(l.orderedAt),
    time: formatDhakaTime(l.orderedAt),
    // What the edit form's datetime-local input needs, already in Dhaka time.
    orderedAtInput: toDhakaInputValue(l.orderedAt),
    customerName: l.customerName,
    phone: l.phone,
    altPhone: l.altPhone,
    address: l.address,
    itemsText: l.itemsText,
    total: Number(l.total),
    callStatus: l.callStatus as string,
    callAttempts: l.callAttempts,
    calledByName: l.calledByName,
    customerAdvice: l.customerAdvice,
    internalNote: l.internalNote,
    convertedCustomerId: l.convertedCustomerId,
  }));

  return (
    <div className="space-y-6">
      <PageHeader icon={<PhoneCall />} color="sky" title="Call list" count={leadCount} />
      <LeadManager slug={slug} leads={rows} perms={perms} />
      <Pagination
        page={page}
        totalPages={Math.ceil(leadCount / PAGE_SIZE)}
        basePath={`/${slug}/leads`}
      />
    </div>
  );
}
