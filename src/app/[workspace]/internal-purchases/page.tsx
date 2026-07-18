import { redirect } from "next/navigation";
import { workspaceAccess } from "@/lib/authz";
import { can } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { InternalPurchaseManager } from "@/components/internal-purchases/internal-purchase-manager";
import { serverT } from "@/lib/session";

export default async function InternalPurchasesPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  const access = await workspaceAccess(slug);
  if (!access) redirect("/");
  if (!can(access.role, "internal-purchases", "view", access.permissions)) {
    redirect(`/${slug}/dashboard`);
  }

  const perms = {
    canAdd: can(access.role, "internal-purchases", "add", access.permissions),
    canEdit: can(access.role, "internal-purchases", "edit", access.permissions),
  };

  const items = await prisma.internalPurchase.findMany({
    where: { workspaceId: access.workspaceId },
    orderBy: { date: "desc" },
    take: 200,
  });

  const rows = items.map((i) => ({
    id: i.id,
    date: i.date.toISOString().slice(0, 10),
    itemName: i.itemName,
    description: i.description,
    supplierName: i.supplierName,
    cost: Number(i.cost),
    quantity: i.quantity,
    category: i.category,
  }));

  const totalSpend = rows.reduce((s, r) => s + r.cost * r.quantity, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">{(await serverT())("internalPurchases")}</h1>
        <span className="text-sm text-muted-foreground">
          Total spend: <span className="font-semibold">{totalSpend.toFixed(2)}</span>
        </span>
      </div>
      <InternalPurchaseManager slug={slug} items={rows} perms={perms} />
    </div>
  );
}
