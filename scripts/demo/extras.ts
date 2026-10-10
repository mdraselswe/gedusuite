/**
 * What makes the demo workspace look lived-in beyond the base trading story:
 * part-paid and gifted orders, a giveaway, parcels still travelling back, an
 * expiring product, a second ad campaign, website leads on the call list and a
 * damaged-stock adjustment.
 *
 * Everything goes through the same actions and webhook path the real app uses.
 * Only run for the demo — never part of the Golden Master dataset.
 */
import { prisma } from "@/lib/prisma";
import { createProduct } from "@/server/actions/products";
import { createPurchase } from "@/server/actions/purchases";
import { createOrder, updateOrderStatus, recordPayment } from "@/server/actions/orders";
import { createCampaign, createAdSet, addDailySpend } from "@/server/actions/boosting";
import { createStockAdjustment } from "@/server/actions/stock-adjustments";
import { setLeadStatus } from "@/server/actions/leads";
import { createTreasuryEntry } from "@/server/actions/treasury";
import { createCustomer } from "@/server/actions/customers";
import { processWooOrderWebhook } from "@/lib/woo-webhook";
import { actAs, fd } from "../../tests/integration/harness";
import type { DatasetResult } from "./dataset";

type Res = { ok: boolean; error?: string; id?: string };
function must<T extends Res>(r: T, what: string): T & { id?: string } {
  if (!r.ok) throw new Error(`demo extras: ${what} failed — ${r.error ?? "unknown"}`);
  return r as T & { id?: string };
}

function ymd(offsetFromToday: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetFromToday);
  return d.toISOString().slice(0, 10);
}

export async function addDemoExtras(ctx: DatasetResult): Promise<void> {
  const { slug, workspaceId } = ctx;
  await actAs(ctx.users.owner);

  const variants = await prisma.productVariant.findMany({
    where: { product: { workspaceId } },
    include: { product: { select: { name: true } } },
  });
  const find = (name: string, attr?: string) => {
    const v = variants.find(
      (x) =>
        x.product.name === name &&
        (!attr || JSON.stringify(x.attributes).includes(attr)),
    );
    if (!v) throw new Error(`demo extras: variant ${name} ${attr ?? ""} not found`);
    return v;
  };
  const courier = await prisma.courier.findFirstOrThrow({
    where: { workspaceId },
    include: { zones: true },
  });
  const customers = await prisma.customer.findMany({ where: { workspaceId }, take: 12 });
  const zone = (n: string) => courier.zones.find((z) => z.name === n)!;
  let nextCustomer = 3;

  const order = async (over: Record<string, unknown>, lines: { v: { id: string; salePrice: unknown }; q: number }[]) =>
    must(
      await createOrder(
        slug,
        fd({
          customerId: customers[nextCustomer++ % customers.length].id,
          status: "CONFIRMED",
          deliveryType: "COURIER",
          deliveryCharge: 80,
          courierId: courier.id,
          courierZoneId: zone("Inside Dhaka").id,
          weightKg: 1,
          paymentMethod: "COURIER_COLLECTION",
          paymentStatus: "UNPAID",
          packagingCost: 12,
          items: lines.map((l) => ({
            productVariantId: l.v.id,
            quantity: l.q,
            unitPrice: Number(l.v.salePrice),
            discount: 0,
          })),
          ...over,
        }),
      ),
      "order",
    );

  // ── An expiring product ──────────────────────────────────────────
  must(
    await createProduct(
      slug,
      fd({
        name: "Baby Cereal 300g",
        category: "Feeding",
        expiryTracked: "true",
        lowStockThreshold: 6,
        weightGrams: 320,
        attributeNames: ["Flavour"],
        variants: [
          { attributes: [{ name: "Flavour", value: "Rice & milk" }], salePrice: 340, unitCost: 215 },
          { attributes: [{ name: "Flavour", value: "Banana" }], salePrice: 340, unitCost: 215 },
        ],
      }),
    ),
    "cereal",
  );
  const cereal = await prisma.productVariant.findMany({
    where: { product: { workspaceId, name: "Baby Cereal 300g" } },
  });
  for (const [i, v] of cereal.entries()) {
    must(
      await createPurchase(
        slug,
        fd({
          productVariantId: v.id,
          date: ymd(-40),
          unitCost: 215,
          quantity: 24,
          fundingSource: "TREASURY",
          expiryDate: ymd(i === 0 ? 18 : 140),
        }),
      ),
      "cereal purchase",
    );
  }

  // ── Part-paid, gifted and giveaway orders ────────────────────────
  const lotion = find("Baby Lotion", "400ml");
  const bear = find("Soft Toy Bear", "Large");
  const blanket = find("Baby Blanket", "Pink");
  const teether = find("Teether Set");

  const part1 = await order(
    { date: ymd(-6), paymentStatus: "PARTIAL", amountPaid: 500, paymentMethod: "BKASH" },
    [{ v: bear, q: 1 }],
  );
  await updateOrderStatus(slug, part1.id!, "SHIPPED");
  await order(
    { date: ymd(-3), paymentStatus: "PARTIAL", amountPaid: 300, paymentMethod: "BKASH" },
    [{ v: blanket, q: 1 }],
  );
  await order(
    { date: ymd(-4), gifts: [{ productVariantId: teether.id, quantity: 1 }] },
    [{ v: lotion, q: 2 }],
  );
  await order({ date: ymd(-5), isGiveaway: "true", deliveryCharge: 0 }, [{ v: teether, q: 1 }]);

  // A parcel refused at the door and still on its way back.
  const refused = await order({ date: ymd(-8) }, [{ v: blanket, q: 1 }]);
  await updateOrderStatus(slug, refused.id!, "SHIPPED");
  must(
    await updateOrderStatus(slug, refused.id!, "CANCELLED", {
      deliveryCost: 60,
      cancelledCollected: 0,
      goodsInTransit: true,
    } as never),
    "refused parcel",
  );

  // Today's orders waiting to be packed.
  for (const [i, v] of [lotion, bear, blanket].entries()) {
    await order({ date: ymd(0), status: i === 0 ? "PENDING" : "CONFIRMED" }, [{ v, q: 1 }]);
  }

  // One customer who paid the rest later.
  const settled = await order({ date: ymd(-9) }, [{ v: lotion, q: 1 }]);
  await updateOrderStatus(slug, settled.id!, "SHIPPED");
  await updateOrderStatus(slug, settled.id!, "DELIVERED");
  await recordPayment(slug, settled.id!, 860);

  // ── Damaged stock ─────────────────────────────────────────────────
  must(
    await createStockAdjustment(
      slug,
      fd({
        productVariantId: find("Feeding Bottle", "150ml").id,
        type: "DAMAGED",
        quantity: 2,
        reason: "Cracked in the stockroom",
        date: ymd(-12),
      }),
    ),
    "adjustment",
  );

  // ── A second campaign ────────────────────────────────────────────
  const camp2 = must(
    await createCampaign(
      slug,
      fd({ name: "Eid Gift Reels", objective: "Sales", channel: "INSTAGRAM", status: "ACTIVE" }),
    ),
    "campaign 2",
  );
  const set2 = must(
    await createAdSet(
      slug,
      camp2.id!,
      fd({ name: "Gift buyers — Dhaka", startDate: ymd(-20), dailyBudget: 400, status: "ACTIVE" }),
    ),
    "adset 2",
  );
  for (let d = 20; d >= 1; d -= 2) {
    must(
      await addDailySpend(
        slug,
        set2.id!,
        fd({ date: ymd(-d), amount: 280 + ((d * 37) % 160), fundingSource: "TREASURY" }),
      ),
      "spend 2",
    );
  }

  // ── Treasury: shop rent and a stall day ──────────────────────────
  await createTreasuryEntry(
    slug,
    fd({ type: "OUT", amount: 6000, source: "Shop rent", note: "Monthly", date: ymd(-10) }),
  );
  await createTreasuryEntry(
    slug,
    fd({ type: "IN", amount: 7350, source: "Stall sales (cash)", note: "Weekend fair", date: ymd(-7) }),
  );

  // ── A few customers marked for a re-engagement call ──────────────
  must(
    await createCustomer(
      slug,
      fd({
        name: "Tahmina Rahman",
        phone: "01715550123",
        address: "Banani, Dhaka",
        reengageEnabled: "on",
        reengageNote: "Bought a blanket in spring — ask about the winter range",
        reengageNextReachAt: ymd(2),
      }),
    ),
    "customer",
  );

  // ── Website orders on the call list, via the real webhook path ───
  const woo = [
    ["Mehjabin Tanha", "01718880101", "House 12, Road 5, Mohammadpur, Dhaka", "Baby Lotion 400ml", 780],
    ["Anika Tabassum", "01918880102", "Zindabazar, Sylhet", "Feeding Bottle 250ml × 2", 1040],
    ["Rubina Yasmin", "01818880103", "Sonadanga, Khulna", "Soft Toy Bear Large", 1250],
    ["Sadika Haque", "01718880104", "Agrabad, Chattogram", "Baby Diaper Pants M", 1450],
    ["Lubna Akter", "01618880105", "Uttara Sector 11, Dhaka", "Baby Blanket Blue × 2", 1980],
    ["Mousumi Das", "01518880106", "Kandirpar, Cumilla", "Teether Set × 3", 1050],
  ] as const;
  for (const [i, [name, phone, addr, item, total]] of woo.entries()) {
    const when = new Date();
    when.setUTCHours(when.getUTCHours() - (i * 7 + 2));
    await processWooOrderWebhook(
      workspaceId,
      JSON.stringify({
        id: 9100 + i,
        number: String(9100 + i),
        status: i === 5 ? "on-hold" : "processing",
        date_created_gmt: when.toISOString().slice(0, 19),
        total: total.toFixed(2),
        payment_method: "cod",
        billing: {
          first_name: name.split(" ")[0],
          last_name: name.split(" ").slice(1).join(" "),
          phone,
          address_1: addr,
          city: addr.split(",").slice(-1)[0].trim(),
          state: "BD-13",
        },
        line_items: [{ name: item, quantity: 1 }],
      }),
    );
  }
  const leads = await prisma.orderLead.findMany({
    where: { workspaceId },
    orderBy: { externalId: "asc" },
  });
  const statuses = ["CONFIRMED", "CALL_LATER", "NO_ANSWER", "WILL_CONFIRM"];
  for (const [i, lead] of leads.slice(0, 4).entries()) {
    await setLeadStatus(slug, lead.id, statuses[i]);
  }

  await actAs(null);
}
