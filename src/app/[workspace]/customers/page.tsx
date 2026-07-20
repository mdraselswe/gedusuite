import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { serverT } from "@/lib/session";
import { CustomerManager } from "@/components/customers/customer-manager";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { PageHeader } from "@/components/ui/page-header";
import { Users } from "lucide-react";

const PAGE_SIZE = 50;

export default async function CustomersPage({
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
  if (!can(access.role, "customers", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "customers", "add", access.permissions),
    canEdit: can(access.role, "customers", "edit", access.permissions),
  };

  const [customerCount, customers] = await Promise.all([
    prisma.customer.count({ where: { workspaceId: access.workspaceId } }),
    prisma.customer.findMany({
      where: { workspaceId: access.workspaceId },
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        orders: {
          where: { status: { not: "CANCELLED" } },
          include: { items: { include: { returns: true } } },
        },
      },
    }),
  ]);

  const rows = customers.map((c) => {
    // Outstanding = total owed on non-cancelled orders not fully paid.
    const outstanding = c.orders
      .filter((o) => o.paymentStatus !== "PAID")
      .reduce((s, o) => s + computeOrderTotals(o).customerTotal, 0);
    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      address: c.address,
      notes: c.notes,
      orderCount: c.orders.length,
      outstanding: Math.round((outstanding + Number.EPSILON) * 100) / 100,
    };
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader icon={<Users />} color="pink" title={(await serverT())("customers")} />
      <CustomerManager slug={slug} customers={rows} perms={perms} />
      <Pagination
        page={page}
        totalPages={Math.ceil(customerCount / PAGE_SIZE)}
        basePath={`/${slug}/customers`}
      />
    </div>
  );
}
