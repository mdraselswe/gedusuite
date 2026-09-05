import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { variantFullName } from "@/lib/variants";

/** Read every current variant of flexible products, even if it has no website
 * link yet. Product identity, never a colour name or a website id, defines the
 * pool. Keeping this read at sale time includes newly purchased colours. */
export async function loadFlexibleComboVariants(
  workspaceId: string,
  combos: {
    flexibleVariants: boolean;
    items: { productVariant: { productId: string } }[];
  }[],
  client: Pick<Prisma.TransactionClient, "productVariant"> = prisma,
) {
  const productIds = [...new Set(combos.filter((c) => c.flexibleVariants)
    .flatMap((c) => c.items.map((i) => i.productVariant.productId)))];
  if (!productIds.length) return [];
  const variants = await client.productVariant.findMany({
    where: { productId: { in: productIds }, product: { workspaceId } },
    orderBy: { id: "asc" },
    select: {
      id: true, productId: true, attributes: true, salePrice: true, wooProductId: true,
      product: { select: { name: true, weightGrams: true } },
    },
  });
  return variants.map((v) => ({
    productVariantId: v.id,
    productId: v.productId,
    productName: v.product.name,
    label: variantFullName(v.product.name, v.attributes),
    quantity: 0,
    salePrice: v.salePrice == null ? null : Number(v.salePrice),
    weightGrams: v.product.weightGrams,
    wooProductId: v.wooProductId,
  }));
}
