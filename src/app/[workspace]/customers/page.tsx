import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { CustomerManager } from "@/components/customers/customer-manager";

export default async function CustomersPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "customers", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "customers", "add", access.permissions),
    canEdit: can(access.role, "customers", "edit", access.permissions),
  };

  const customers = await prisma.customer.findMany({
    where: { workspaceId: access.workspaceId },
    orderBy: { name: "asc" },
    include: {
      orders: {
        where: { status: { not: "CANCELLED" } },
        include: { items: { include: { returns: true } } },
      },
    },
  });

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
      <h1 className="text-2xl font-bold">Customers</h1>
      <CustomerManager slug={slug} customers={rows} perms={perms} />
    </div>
  );
}
