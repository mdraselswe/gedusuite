import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { amountOutstanding } from "@/lib/order-cash";
import { dhakaDayKey, dhakaToday } from "@/lib/dhaka-time";
import { serverT } from "@/lib/session";
import { phoneSearchTerms } from "@/lib/phone";
import { CustomerManager } from "@/components/customers/customer-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Money } from "@/components/ui/money";
import { Users } from "lucide-react";
import { round2 } from "@/lib/money";

const PAGE_SIZE = 50;

export default async function CustomersPage({
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
  if (!can(access.role, "customers", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "customers", "add", access.permissions),
    canEdit: can(access.role, "customers", "edit", access.permissions),
  };

  // The search reaches the database, not the 50 rows this page happens to
  // hold. The book runs to several pages and it is sorted by name, so a filter
  // over the visible page could only ever find people whose names start with
  // the right letters — everyone else came back "no data" while sitting two
  // pages down. Numbers are matched in every shape one is stored in (lib/phone),
  // since a customer typed at checkout and one typed by hand rarely agree.
  const phoneTerms = phoneSearchTerms(q);
  const where = {
    workspaceId: access.workspaceId,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { address: { contains: q, mode: "insensitive" as const } },
            ...phoneTerms.flatMap((p) => [
              { phone: { contains: p } },
              { altPhone: { contains: p } },
            ]),
          ],
        }
      : {}),
  };

  const [matchCount, customerCount, customers] = await Promise.all([
    prisma.customer.count({ where }),
    // Unfiltered: the header counts the book, not the search.
    prisma.customer.count({ where: { workspaceId: access.workspaceId } }),
    prisma.customer.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        // Cancellations come too now. They're kept out of order counts and
        // spend, but a customer who refuses parcels costs real courier money,
        // and that was invisible here — the one thing worth knowing before
        // shipping to them again.
        orders: {
          include: { items: { include: { returns: true } } },
        },
      },
    }),
  ]);

  const today = dhakaToday();

  const rows = customers.map((c) => {
    const live = c.orders.filter((o) => o.status !== "CANCELLED");
    // What they still owe, net of anything already paid towards it. This used
    // to add up whole order totals for anything not marked PAID, so a 5,000
    // order settled with a 4,000 advance was chased for the full 5,000 — and
    // this page and the treasury's "Due" disagreed by every advance ever taken.
    const outstanding = live.reduce(
      (s, o) => s + amountOutstanding(o, computeOrderTotals(o)),
      0,
    );
    // What they have been worth: everything they have actually bought.
    const lifetime = live.reduce((s, o) => s + computeOrderTotals(o).customerTotal, 0);
    const lastOrder = live.reduce<Date | null>(
      (latest, o) => (!latest || o.date > latest ? o.date : latest),
      null,
    );
    const lastOrderDay = lastOrder ? dhakaDayKey(lastOrder) : null;
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      altPhone: c.altPhone,
      address: c.address,
      notes: c.notes,
      orderCount: live.length,
      cancelledCount: c.orders.length - live.length,
      outstanding: round2(outstanding),
      lifetime: round2(lifetime),
      lastOrderDay,
      // Worked out here rather than in the browser: the client would compute it
      // against its own clock and its own timezone, and a number that differs
      // between the server render and the first paint is a hydration mismatch.
      daysSinceOrder:
        lastOrderDay === null
          ? null
          : Math.round(
              (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastOrderDay}T00:00:00Z`)) /
                86_400_000,
            ),
    };
  });

  const totalDue = round2(rows.reduce((s, r) => s + r.outstanding, 0));
  const owingCount = rows.filter((r) => r.outstanding > 0).length;
  // The dues line adds up the customers actually listed, which is the whole
  // book only when one page holds it and nothing is being searched for. It
  // says so rather than letting a search's total read as the shop's.
  const duesAreEverybody = !q && customerCount <= rows.length;

  return (
    <div className="space-y-6">
      {/* The money goes in the header, the way it does on treasury — it was a
          line of grey text wedged between the search box and the filters. */}
      <PageHeader
        icon={<Users />}
        color="pink"
        title={(await serverT())("customers")}
        count={customerCount}
        action={
          totalDue > 0 ? (
            <span className="text-sm text-muted-foreground">
              {duesAreEverybody ? "Owed by customers" : "Owed by those shown"}:{" "}
              <Money value={totalDue} tone="negative" className="text-lg font-bold" />
              <span className="ml-1">
                across {owingCount} {owingCount === 1 ? "customer" : "customers"}
              </span>
            </span>
          ) : undefined
        }
      />
      <CustomerManager
        slug={slug}
        customers={rows}
        perms={perms}
        query={q}
        total={matchCount}
      />
      <Pagination
        page={page}
        totalPages={Math.ceil(matchCount / PAGE_SIZE)}
        basePath={`/${slug}/customers`}
        query={{ q: q || undefined }}
      />
    </div>
  );
}
