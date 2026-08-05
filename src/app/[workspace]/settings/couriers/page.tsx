import { redirect } from "next/navigation";
import { Truck } from "lucide-react";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { CourierManager } from "@/components/settings/courier-manager";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Courier pricing rules. Gated on `sales` rather than a module of its own:
 * these are the numbers behind every order's delivery cost, and whoever runs
 * sales is who knows them.
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
  const canEdit = can(access.role, "sales", "edit", access.permissions);

  const couriers = await prisma.courier.findMany({
    where: { workspaceId: access.workspaceId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: {
      zones: { orderBy: { sortOrder: "asc" } },
      _count: { select: { orders: true } },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader icon={<Truck />} color="violet" title="Couriers" count={couriers.length} />
      <CourierManager
        slug={slug}
        canEdit={canEdit}
        couriers={couriers.map((c) => ({
          id: c.id,
          name: c.name,
          isDefault: c.isDefault,
          isActive: c.isActive,
          baseWeightKg: Number(c.baseWeightKg),
          extraKgRate: Number(c.extraKgRate),
          codFeePercent: Number(c.codFeePercent),
          codFeeBase: c.codFeeBase,
          returnChargeType: c.returnChargeType,
          returnChargeValue: Number(c.returnChargeValue),
          notes: c.notes,
          zones: c.zones.map((z) => ({ id: z.id, name: z.name, rate: Number(z.rate) })),
          orderCount: c._count.orders,
        }))}
      />
    </div>
  );
}
