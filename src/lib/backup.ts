import { prisma } from "@/lib/prisma";
import { computeOrderTotals } from "@/lib/orders";
import { treasuryBalance } from "@/lib/finance";
import type { BackupSummary } from "@/lib/google";
import { round2 } from "@/lib/money";

export const SNAPSHOT_VERSION = 1;

/** At-a-glance totals for the backup sheet's summary tab. */
export async function computeBackupSummary(
  workspaceId: string,
  workspaceName: string,
): Promise<BackupSummary> {
  const [orders, purchases, balance, partners] = await Promise.all([
    prisma.order.findMany({
      where: { workspaceId, status: { not: "CANCELLED" } },
      include: { items: { include: { returns: true } } },
    }),
    prisma.purchase.findMany({ where: { workspaceId }, select: { unitCost: true, quantity: true } }),
    treasuryBalance(workspaceId),
    // Names for the sheets. They come from User, which the snapshot leaves out
    // on purpose, so they travel with the summary instead — the workbook would
    // otherwise print a cuid wherever a partner belongs.
    prisma.partner.findMany({
      where: { workspaceId },
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
  ]);
  const totalSales = orders.reduce((s, o) => s + computeOrderTotals(o).netRevenue, 0);
  const totalPurchases = purchases.reduce((s, p) => s + Number(p.unitCost) * p.quantity, 0);
  return {
    workspaceName,
    totalSales: round2(totalSales),
    totalPurchases: round2(totalPurchases),
    treasuryBalance: balance,
    lastSync: new Date().toISOString().slice(0, 16).replace("T", " "),
    partnerNames: Object.fromEntries(
      partners.map((p) => [p.id, p.user.name ?? p.user.email]),
    ),
  };
}

// Tables included in a full-workspace snapshot, in parent→child insert order.
// (Auth/user rows and notifications/backup logs are intentionally excluded.)
export type Snapshot = {
  version: number;
  workspaceId: string;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
};

/** Serialize all business data for a workspace into a plain JSON object. */
export async function buildSnapshot(workspaceId: string): Promise<Snapshot> {
  const [
    suppliers,
    products,
    productCategories,
    productVariants,
    customers,
    purchases,
    partners,
    profitDistributions,
    partnerTxns,
    treasuryEntries,
    orders,
    orderItems,
    orderGifts,
    returns,
    internalPurchases,
    boostCampaigns,
    boostAdSets,
    boostDailySpends,
    couriers,
    courierZones,
    comboSets,
    comboItems,
  ] = await Promise.all([
    prisma.supplier.findMany({ where: { workspaceId } }),
    prisma.product.findMany({ where: { workspaceId } }),
    prisma.productCategory.findMany({ where: { workspaceId } }),
    prisma.productVariant.findMany({ where: { product: { workspaceId } } }),
    prisma.customer.findMany({ where: { workspaceId } }),
    prisma.purchase.findMany({ where: { workspaceId } }),
    prisma.partner.findMany({ where: { workspaceId } }),
    prisma.profitDistribution.findMany({ where: { workspaceId } }),
    prisma.partnerTxn.findMany({ where: { workspaceId } }),
    prisma.treasuryEntry.findMany({ where: { workspaceId } }),
    prisma.order.findMany({ where: { workspaceId } }),
    prisma.orderItem.findMany({ where: { order: { workspaceId } } }),
    prisma.orderGift.findMany({ where: { order: { workspaceId } } }),
    prisma.return.findMany({ where: { workspaceId } }),
    prisma.internalPurchase.findMany({ where: { workspaceId } }),
    prisma.boostCampaign.findMany({ where: { workspaceId } }),
    prisma.boostAdSet.findMany({ where: { workspaceId } }),
    prisma.boostDailySpend.findMany({ where: { workspaceId } }),
    prisma.courier.findMany({ where: { workspaceId } }),
    prisma.courierZone.findMany({ where: { workspaceId } }),
    prisma.comboSet.findMany({ where: { workspaceId } }),
    prisma.comboItem.findMany({ where: { comboSet: { workspaceId } } }),
  ]);
  const stockAdjustments = await prisma.stockAdjustment.findMany({ where: { workspaceId } });

  // JSON.stringify serializes Prisma Decimal → numeric string and Date → ISO,
  // both of which Prisma accepts back as inputs on restore.
  const tables = {
    suppliers,
    products,
    productCategories,
    productVariants,
    customers,
    purchases,
    partners,
    profitDistributions,
    partnerTxns,
    treasuryEntries,
    orders,
    orderItems,
    orderGifts,
    returns,
    internalPurchases,
    stockAdjustments,
    boostCampaigns,
    boostAdSets,
    boostDailySpends,
    couriers,
    courierZones,
    comboSets,
    comboItems,
  } as unknown as Snapshot["tables"];

  return {
    version: SNAPSHOT_VERSION,
    workspaceId,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

export type SnapshotCounts = Record<string, number>;

/** Validate the shape of an uploaded snapshot and return per-table row counts. */
export function validateSnapshot(
  data: unknown,
): { ok: true; snapshot: Snapshot; counts: SnapshotCounts } | { ok: false; error: string } {
  if (!data || typeof data !== "object") return { ok: false, error: "Not a valid backup file" };
  const s = data as Partial<Snapshot>;
  if (typeof s.version !== "number" || !s.tables || typeof s.tables !== "object") {
    return { ok: false, error: "Missing version or tables" };
  }
  if (s.version > SNAPSHOT_VERSION) {
    return { ok: false, error: `Backup version ${s.version} is newer than supported` };
  }
  const counts: SnapshotCounts = {};
  for (const [k, v] of Object.entries(s.tables)) {
    if (!Array.isArray(v)) return { ok: false, error: `Table "${k}" is malformed` };
    counts[k] = v.length;
  }
  return {
    ok: true,
    snapshot: { version: s.version, workspaceId: s.workspaceId ?? "", exportedAt: s.exportedAt ?? "", tables: s.tables },
    counts,
  };
}

export type RestoreMode = "MERGE" | "OVERWRITE";

/**
 * Restore a snapshot into a workspace. OVERWRITE clears existing business data
 * first; MERGE inserts only rows whose ids don't already exist. Dangling
 * references (missing member/user) are nulled or skipped so the import can't
 * fail on referential integrity. Runs in a single transaction.
 */
export async function restoreSnapshot(
  workspaceId: string,
  snapshot: Snapshot,
  mode: RestoreMode,
): Promise<{ inserted: SnapshotCounts }> {
  type Row = Record<string, unknown>;
  const t = snapshot.tables;
  const rows = (name: string): Row[] => (t[name] ?? []) as Row[];

  // Reference sets in the target workspace for sanitizing dangling FKs.
  const [memberships, users] = await Promise.all([
    prisma.membership.findMany({ where: { workspaceId }, select: { id: true } }),
    prisma.user.findMany({ select: { id: true } }),
  ]);
  const membershipIds = new Set(memberships.map((m) => m.id));
  const userIds = new Set(users.map((u) => u.id));

  const force = (list: Row[]): Row[] =>
    list.map((r) => ({ ...r, workspaceId }) as Row);

  const suppliers = force(rows("suppliers"));
  const products = force(rows("products"));
  const productCategories = force(rows("productCategories"));
  const productVariants = rows("productVariants");
  const customers = force(rows("customers"));
  const purchases = force(rows("purchases"));
  // Skip partners whose user no longer exists (would violate the FK).
  const partners = force(rows("partners")).filter((p) => userIds.has(p.userId as string));
  const validPartnerIds = new Set(partners.map((p) => p.id as string));
  const profitDistributions = force(rows("profitDistributions"));
  // Null dangling distribution links (e.g. backups from before distributions
  // were included in the snapshot).
  const validDistributionIds = new Set(profitDistributions.map((d) => d.id as string));
  // Boost tables come before partner txns and treasury entries: both can
  // reference a boost spend (boostSpendId), so the spends must exist first
  // on insert.
  const boostCampaigns = force(rows("boostCampaigns"));
  const validCampaignIds = new Set(boostCampaigns.map((c) => c.id as string));
  const boostAdSets = force(rows("boostAdSets"))
    .filter((a) => validCampaignIds.has(a.campaignId as string))
    .map((a) => {
      // Snapshots from before the daily-budget rename carry `budget`.
      const { budget, ...rest } = a as Row & { budget?: unknown };
      return (rest.dailyBudget !== undefined ? rest : { ...rest, dailyBudget: budget ?? null }) as Row;
    });
  const validAdSetIds = new Set(boostAdSets.map((a) => a.id as string));
  const boostDailySpends = force(rows("boostDailySpends"))
    .filter((s) => validAdSetIds.has(s.adSetId as string))
    .map(
      (s) =>
        ({
          ...s,
          paidByPartnerId: validPartnerIds.has(s.paidByPartnerId as string)
            ? s.paidByPartnerId
            : null,
        }) as Row,
    );
  const validBoostSpendIds = new Set(boostDailySpends.map((s) => s.id as string));
  const partnerTxns = force(rows("partnerTxns"))
    .filter((x) => validPartnerIds.has(x.partnerId as string))
    .map(
      (x) =>
        ({
          ...x,
          distributionId: validDistributionIds.has(x.distributionId as string)
            ? x.distributionId
            : null,
          boostSpendId: validBoostSpendIds.has(x.boostSpendId as string) ? x.boostSpendId : null,
        }) as Row,
    );
  const validTxnIds = new Set(partnerTxns.map((x) => x.id as string));
  const treasuryEntries = force(rows("treasuryEntries")).map(
    (e) =>
      ({
        ...e,
        partnerId: validPartnerIds.has(e.partnerId as string) ? e.partnerId : null,
        partnerTxnId: validTxnIds.has(e.partnerTxnId as string) ? e.partnerTxnId : null,
        distributionId: validDistributionIds.has(e.distributionId as string)
          ? e.distributionId
          : null,
        boostSpendId: validBoostSpendIds.has(e.boostSpendId as string) ? e.boostSpendId : null,
      }) as Row,
  );
  const orders = force(rows("orders")).map(
    (o) =>
      ({
        ...o,
        heldByMembershipId: membershipIds.has(o.heldByMembershipId as string)
          ? o.heldByMembershipId
          : null,
      }) as Row,
  );
  const orderItems = rows("orderItems");
  const orderGifts = rows("orderGifts");
  const returns = force(rows("returns"));
  const internalPurchases = force(rows("internalPurchases"));
  const stockAdjustments = force(rows("stockAdjustments"));
  const comboSets = force(rows("comboSets"));
  // ComboItem has no workspaceId of its own — it hangs off the combo — so it is
  // the one child table here that must NOT be forced into the workspace.
  const comboItems = rows("comboItems");

  const inserted: SnapshotCounts = {};

  await prisma.$transaction(
    async (tx) => {
      if (mode === "OVERWRITE") {
        // Delete children → parents.
        await tx.return.deleteMany({ where: { workspaceId } });
        await tx.orderGift.deleteMany({ where: { order: { workspaceId } } });
        await tx.orderItem.deleteMany({ where: { order: { workspaceId } } });
        await tx.order.deleteMany({ where: { workspaceId } });
        await tx.treasuryEntry.deleteMany({ where: { workspaceId } });
        await tx.partnerTxn.deleteMany({ where: { workspaceId } });
        await tx.profitDistribution.deleteMany({ where: { workspaceId } });
        await tx.partner.deleteMany({ where: { workspaceId } });
        await tx.stockAdjustment.deleteMany({ where: { workspaceId } });
        await tx.purchase.deleteMany({ where: { workspaceId } });
        // Before the variants: a ComboItem's FK to ProductVariant is Restrict,
        // so a variant that some recipe still lists cannot be deleted, and the
        // whole restore would fail on the first shop that sells a combo.
        await tx.comboItem.deleteMany({ where: { comboSet: { workspaceId } } });
        await tx.comboSet.deleteMany({ where: { workspaceId } });
        await tx.productVariant.deleteMany({ where: { product: { workspaceId } } });
        await tx.product.deleteMany({ where: { workspaceId } });
        await tx.productCategory.deleteMany({ where: { workspaceId } });
        await tx.customer.deleteMany({ where: { workspaceId } });
        await tx.supplier.deleteMany({ where: { workspaceId } });
        await tx.internalPurchase.deleteMany({ where: { workspaceId } });
        await tx.boostDailySpend.deleteMany({ where: { workspaceId } });
        await tx.boostAdSet.deleteMany({ where: { workspaceId } });
        await tx.boostCampaign.deleteMany({ where: { workspaceId } });
        // After orders, whose courierId/courierZoneId point here.
        await tx.courierZone.deleteMany({ where: { workspaceId } });
        await tx.courier.deleteMany({ where: { workspaceId } });
      }

      const skip = mode === "MERGE";
      const insert = async (
        name: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        model: { createMany: (a: any) => Promise<{ count: number }> },
        data: Record<string, unknown>[],
      ) => {
        if (data.length === 0) {
          inserted[name] = 0;
          return;
        }
        const res = await model.createMany({ data: data as never, skipDuplicates: skip });
        inserted[name] = res.count;
      };

      // Parents → children.
      await insert("suppliers", tx.supplier, suppliers);
      await insert("products", tx.product, products);
      await insert("productCategories", tx.productCategory, productCategories);
      await insert("productVariants", tx.productVariant, productVariants);
      await insert("customers", tx.customer, customers);
      await insert("purchases", tx.purchase, purchases);
      await insert("partners", tx.partner, partners);
      await insert("profitDistributions", tx.profitDistribution, profitDistributions);
      // Before orders: an order carries the courier and zone that priced it.
      await insert("couriers", tx.courier, force(rows("couriers")));
      await insert("courierZones", tx.courierZone, force(rows("courierZones")));
      await insert("boostCampaigns", tx.boostCampaign, boostCampaigns);
      await insert("boostAdSets", tx.boostAdSet, boostAdSets);
      await insert("boostDailySpends", tx.boostDailySpend, boostDailySpends);
      // Ahead of partnerTxns and treasuryEntries: both carry an
      // internalPurchaseId FK for rows generated by a funded internal
      // purchase, so the purchase has to exist before they land.
      await insert("internalPurchases", tx.internalPurchase, internalPurchases);
      await insert("partnerTxns", tx.partnerTxn, partnerTxns);
      await insert("treasuryEntries", tx.treasuryEntry, treasuryEntries);
      await insert("orders", tx.order, orders);
      await insert("orderItems", tx.orderItem, orderItems);
      await insert("orderGifts", tx.orderGift, orderGifts);
      await insert("returns", tx.return, returns);
      await insert("stockAdjustments", tx.stockAdjustment, stockAdjustments);
      // After the variants they are built from. Order lines reference a combo
      // by a plain id rather than a foreign key, so they can go in either way
      // round — but a report reading a restored order still wants its name.
      await insert("comboSets", tx.comboSet, comboSets);
      await insert("comboItems", tx.comboItem, comboItems);
    },
    { timeout: 30_000 },
  );

  return { inserted };
}
