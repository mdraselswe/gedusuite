// Export products (name, category, price, stock) as JSON for the WooCommerce
// import that feeds gedushop-frontend. Read-only — no writes.
// Run: npx dotenv -e .env.local -- node scripts/export-woo.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const STOCK_CONSUMING = ["CONFIRMED", "SHIPPED", "DELIVERED"];

const workspaces = await prisma.workspace.findMany({ select: { id: true, name: true } });
console.error("workspaces:", workspaces.map((w) => w.name).join(", "));
const ws = workspaces.find((w) => w.name === "GeduShop") ?? workspaces[0];
console.error("using workspace:", ws.name);

const products = await prisma.product.findMany({
  where: { workspaceId: ws.id },
  include: {
    variants: {
      include: {
        purchases: { orderBy: { date: "desc" }, take: 1, select: { salePrice: true, unitCost: true, date: true } },
      },
    },
  },
  orderBy: { name: "asc" },
});

// stock per variant = purchased − sold − gifted + returned + adjustments (mirrors src/lib/inventory.ts)
const [purchased, sold, gifted, returns, adjustments] = await Promise.all([
  prisma.purchase.groupBy({ by: ["productVariantId"], where: { workspaceId: ws.id }, _sum: { quantity: true } }),
  prisma.orderItem.groupBy({
    by: ["productVariantId"],
    where: { order: { workspaceId: ws.id, status: { in: STOCK_CONSUMING } } },
    _sum: { quantity: true },
  }),
  prisma.orderGift.groupBy({
    by: ["productVariantId"],
    where: { order: { workspaceId: ws.id, status: { in: STOCK_CONSUMING } }, productVariantId: { not: null } },
    _sum: { quantity: true },
  }),
  prisma.return.findMany({
    where: { workspaceId: ws.id, orderItem: { order: { status: { in: STOCK_CONSUMING } } } },
    select: { quantity: true, orderItem: { select: { productVariantId: true } } },
  }),
  prisma.stockAdjustment.groupBy({ by: ["productVariantId"], where: { workspaceId: ws.id }, _sum: { delta: true } }),
]);

const stock = new Map();
for (const r of purchased) stock.set(r.productVariantId, r._sum.quantity ?? 0);
for (const r of sold) stock.set(r.productVariantId, (stock.get(r.productVariantId) ?? 0) - (r._sum.quantity ?? 0));
for (const r of gifted) stock.set(r.productVariantId, (stock.get(r.productVariantId) ?? 0) - (r._sum.quantity ?? 0));
for (const r of returns) {
  const vid = r.orderItem.productVariantId;
  stock.set(vid, (stock.get(vid) ?? 0) + r.quantity);
}
for (const r of adjustments) stock.set(r.productVariantId, (stock.get(r.productVariantId) ?? 0) + (r._sum.delta ?? 0));

const out = products.map((p) => ({
  name: p.name,
  category: p.category,
  sku: p.sku,
  unitsPerPack: p.unitsPerPack,
  hasImage: Boolean(p.imageUrl),
  variants: p.variants.map((v) => ({
    size: v.size,
    color: v.color,
    sku: v.sku,
    salePrice: v.purchases[0]?.salePrice ? Number(v.purchases[0].salePrice) : null,
    stock: stock.get(v.id) ?? 0,
  })),
}));

console.log(JSON.stringify(out, null, 2));
console.error(`\n${out.length} products, ${out.reduce((n, p) => n + p.variants.length, 0)} variants`);
await prisma.$disconnect();
