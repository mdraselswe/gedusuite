/**
 * One believable small business, written through the app's own server actions.
 *
 * Used twice: as the Golden Master baseline (a fixed, deterministic dataset the
 * money figures are pinned against) and as the demo workspace shown to
 * customers. Because every row goes through the same actions the UI calls,
 * stock, treasury, courier fees and profit agree with each other by
 * construction — nothing here writes a derived number by hand.
 *
 * Deterministic: a seeded PRNG and explicit dates, never Math.random() or now.
 */
import { prisma } from "@/lib/prisma";
import { createProduct } from "@/server/actions/products";
import { createSupplier } from "@/server/actions/suppliers";
import { createPurchase } from "@/server/actions/purchases";
import { createCustomer } from "@/server/actions/customers";
import { createCourier } from "@/server/actions/couriers";
import {
  createOrder,
  updateOrderStatus,
  recordPayment,
  createReturn,
} from "@/server/actions/orders";
import { createPartner, createPartnerTxn } from "@/server/actions/partners";
import { createTreasuryEntry } from "@/server/actions/treasury";
import { createInternalPurchase } from "@/server/actions/internal-purchases";
import { createDistribution } from "@/server/actions/distributions";
import { markAllCashDeposited } from "@/server/actions/cash-custody";
import { createCampaign, createAdSet, addDailySpend } from "@/server/actions/boosting";
import { actAs, addMember, createUser, createWorkspaceWithOwner, fd } from "../../tests/integration/harness";

export type DatasetOptions = {
  slug: string;
  workspaceName: string;
  /** First calendar day of the story, YYYY-MM-DD. */
  startDay: string;
  /** How many days the story runs. */
  days: number;
  /** Email domain for the generated users. */
  emailDomain: string;
  /** Orders per day on average (scales the dataset). */
  ordersPerDay: number;
  password?: string;
};

type Res = { ok: boolean; error?: string; id?: string };
function must<T extends Res>(r: T, what: string): T & { id?: string } {
  if (!r.ok) throw new Error(`dataset: ${what} failed — ${r.error ?? "unknown"}`);
  return r as T & { id?: string };
}

// mulberry32 — tiny deterministic PRNG.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const CATALOGUE = [
  { name: "Baby Lotion", category: "Skin care", weight: 250, variants: [{ a: "200ml", price: 450, cost: 290 }, { a: "400ml", price: 780, cost: 520 }] },
  { name: "Baby Shampoo", category: "Skin care", weight: 220, variants: [{ a: "200ml", price: 380, cost: 240 }] },
  { name: "Feeding Bottle", category: "Feeding", weight: 180, variants: [{ a: "150ml", price: 420, cost: 260 }, { a: "250ml", price: 520, cost: 330 }] },
  { name: "Baby Diaper Pants", category: "Diapers", weight: 900, variants: [{ a: "M (48 pcs)", price: 1450, cost: 1080 }, { a: "L (44 pcs)", price: 1480, cost: 1100 }] },
  { name: "Soft Toy Bear", category: "Toys", weight: 300, variants: [{ a: "Small", price: 650, cost: 380 }, { a: "Large", price: 1250, cost: 760 }] },
  { name: "Baby Blanket", category: "Clothing", weight: 500, variants: [{ a: "Pink", price: 990, cost: 610 }, { a: "Blue", price: 990, cost: 610 }] },
  { name: "Teether Set", category: "Toys", weight: 120, variants: [{ a: "3 pcs", price: 350, cost: 190 }] },
  { name: "Baby Wipes", category: "Hygiene", weight: 400, variants: [{ a: "80 pcs", price: 280, cost: 170 }] },
] as const;

const CUSTOMER_NAMES = [
  "Nusrat Jahan", "Farhana Akter", "Sumaiya Rahman", "Tasnim Sultana", "Mst. Rokeya Begum",
  "Shirin Akter", "Jannatul Ferdous", "Maliha Chowdhury", "Sabina Yasmin", "Rumana Haque",
  "Tania Islam", "Nasrin Parvin", "Sharmin Sultana", "Ayesha Siddika", "Mahfuza Khatun",
  "Rima Das", "Lamia Hossain", "Popy Akter", "Sadia Afrin", "Munira Begum",
];
const AREAS = [
  "Mirpur-10, Dhaka", "Dhanmondi 27, Dhaka", "Uttara Sector 7, Dhaka", "Mohammadpur, Dhaka",
  "Chattogram Agrabad", "Sylhet Zindabazar", "Rajshahi Shaheb Bazar", "Khulna Sonadanga",
  "Cumilla Kandirpar", "Bogura Sherpur Road",
];

export type DatasetResult = {
  workspaceId: string;
  slug: string;
  users: { owner: string; partnerA: string; partnerB: string; manager: string; staff: string };
  emails: { owner: string; partnerA: string; partnerB: string; manager: string; staff: string };
};

export async function buildDataset(opts: DatasetOptions): Promise<DatasetResult> {
  const rnd = prng(20261001);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];
  const pw = opts.password ?? "Demo#12345";
  const email = (n: string) => `${n}@${opts.emailDomain}`;

  // ── people ─────────────────────────────────────────────────────────
  const owner = await createUser(email("owner"), "Shahriar Ahmed", pw);
  const partnerA = await createUser(email("partner.rafi"), "Rafiul Islam", pw);
  const partnerB = await createUser(email("partner.mim"), "Mim Chowdhury", pw);
  const manager = await createUser(email("manager"), "Kamal Hossain", pw);
  const staff = await createUser(email("staff"), "Sumon Mia", pw);

  const ws = await createWorkspaceWithOwner(opts.workspaceName, opts.slug, owner.id);
  await addMember(ws.id, partnerA.id, "PARTNER");
  await addMember(ws.id, partnerB.id, "PARTNER");
  await addMember(ws.id, manager.id, "MANAGER");
  await addMember(ws.id, staff.id, "STAFF");
  const slug = opts.slug;

  await actAs(owner.id);

  // ── partners & capital ─────────────────────────────────────────────
  must(await createPartner(slug, fd({ userId: owner.id, profitSharePercent: 50 })), "partner owner");
  must(await createPartner(slug, fd({ userId: partnerA.id, profitSharePercent: 30 })), "partner A");
  must(await createPartner(slug, fd({ userId: partnerB.id, profitSharePercent: 20 })), "partner B");
  const partners = await prisma.partner.findMany({ where: { workspaceId: ws.id }, orderBy: { profitSharePercent: "desc" } });
  const [pOwner, pA, pB] = partners;

  const d0 = opts.startDay;
  must(await createPartnerTxn(slug, fd({ partnerId: pOwner.id, type: "INVESTMENT", amount: 250000, purpose: "Opening capital", date: d0 })), "invest owner");
  must(await createPartnerTxn(slug, fd({ partnerId: pA.id, type: "INVESTMENT", amount: 150000, purpose: "Opening capital", date: d0 })), "invest A");
  must(await createPartnerTxn(slug, fd({ partnerId: pB.id, type: "INVESTMENT", amount: 100000, purpose: "Opening capital", date: d0 })), "invest B");
  must(await createPartnerTxn(slug, fd({ partnerId: pOwner.id, type: "DEPOSIT_TO_TREASURY", amount: 220000, purpose: "Working cash", date: d0 })), "deposit owner");
  must(await createPartnerTxn(slug, fd({ partnerId: pA.id, type: "DEPOSIT_TO_TREASURY", amount: 120000, purpose: "Working cash", date: d0 })), "deposit A");

  // ── suppliers, catalogue ───────────────────────────────────────────
  const s1 = must(await createSupplier(slug, fd({ name: "Bashundhara Wholesale", phone: "01711000001", address: "Islampur, Dhaka" })), "supplier 1");
  const s2 = must(await createSupplier(slug, fd({ name: "Chawkbazar Traders", phone: "01811000002", address: "Chawkbazar, Dhaka" })), "supplier 2");

  for (const p of CATALOGUE) {
    must(
      await createProduct(
        slug,
        fd({
          name: p.name,
          category: p.category,
          lowStockThreshold: 5,
          weightGrams: p.weight,
          attributeNames: ["Variant"],
          variants: p.variants.map((v) => ({
            attributes: [{ name: "Variant", value: v.a }],
            salePrice: v.price,
            unitCost: v.cost,
          })),
        }),
      ),
      `product ${p.name}`,
    );
  }
  const variants = await prisma.productVariant.findMany({
    where: { product: { workspaceId: ws.id } },
    include: { product: { select: { name: true } } },
    orderBy: [{ product: { name: "asc" } }],
  });
  // cuid ids are random, so ordering by id would shuffle same-product variants
  // between runs and make the whole story differ. Order by what they ARE.
  variants.sort((a, b) =>
    `${a.product.name}|${JSON.stringify(a.attributes)}`.localeCompare(
      `${b.product.name}|${JSON.stringify(b.attributes)}`,
    ),
  );

  // Opening stock: mixed funding so every ledger gets exercised.
  const fundings = [
    { fundingSource: "TREASURY" },
    { fundingSource: "PARTNER", paidByPartnerId: pA.id },
    { fundingSource: "CREDIT" },
    { fundingSource: "TREASURY" },
  ];
  let fi = 0;
  for (const v of variants) {
    const f = fundings[fi++ % fundings.length];
    must(
      await createPurchase(
        slug,
        fd({
          productVariantId: v.id,
          supplierId: fi % 2 ? s1.id : s2.id,
          date: addDays(d0, 1),
          unitCost: Number(v.unitCost),
          salePrice: Number(v.salePrice),
          quantity: 60,
          ...f,
        }),
      ),
      `purchase ${v.product.name}`,
    );
  }

  // ── courier ────────────────────────────────────────────────────────
  must(
    await createCourier(slug, {
      name: "Steadfast Courier",
      baseWeightKg: 1,
      extraKgRate: 20,
      codFeePercent: 1,
      codFeeBase: "NET",
      returnChargeType: "PERCENT_OF_DELIVERY",
      returnChargeValue: 50,
      isDefault: true,
      isActive: true,
      zones: [
        { name: "Inside Dhaka", rate: 60, bands: [] },
        { name: "Dhaka Suburb", rate: 100, bands: [] },
        { name: "Outside Dhaka", rate: 120, bands: [] },
      ],
    }),
    "courier",
  );
  const courier = await prisma.courier.findFirstOrThrow({ where: { workspaceId: ws.id }, include: { zones: true } });
  const zone = (n: string) => courier.zones.find((z) => z.name === n)!;

  // ── overhead ───────────────────────────────────────────────────────
  must(await createInternalPurchase(slug, fd({ itemName: "Poly mailer bags (2,000)", cost: 3200, quantity: 1, category: "PACKAGING_MATERIAL", date: addDays(d0, 2), fundingSource: "TREASURY", spreadMonths: 3 })), "packaging");
  must(await createInternalPurchase(slug, fd({ itemName: "Thermal label printer", cost: 9500, quantity: 1, category: "EQUIPMENT", date: addDays(d0, 3), fundingSource: "PARTNER", paidByPartnerId: pB.id })), "printer");
  must(await createInternalPurchase(slug, fd({ itemName: "Office rent", cost: 6000, quantity: 1, category: "RENT", date: addDays(d0, 5), fundingSource: "TREASURY" })), "rent");

  // ── customers ──────────────────────────────────────────────────────
  const customerIds: string[] = [];
  for (let i = 0; i < CUSTOMER_NAMES.length; i++) {
    const r = must(
      await createCustomer(
        slug,
        fd({
          name: CUSTOMER_NAMES[i],
          phone: `0171${String(2000000 + i * 7919).slice(0, 7)}`,
          address: AREAS[i % AREAS.length],
        }),
      ),
      "customer",
    );
    customerIds.push(r.id!);
  }

  // ── advertising ────────────────────────────────────────────────────
  const camp = must(await createCampaign(slug, fd({ name: "Eid Baby Gift Boost", objective: "Sales", channel: "FACEBOOK", status: "ACTIVE" })), "campaign");
  const adset = must(
    await createAdSet(slug, camp.id!, fd({ name: "Dhaka mothers 22-38", startDate: addDays(d0, 4), dailyBudget: 600, status: "ACTIVE" })),
    "adset",
  );

  // ── trading days ───────────────────────────────────────────────────
  const orderIds: { id: string; status: string; date: string }[] = [];
  for (let day = 4; day < opts.days; day++) {
    const date = addDays(d0, day);
    // a little ad spend most days
    if (day % 2 === 0) {
      must(
        await addDailySpend(slug, adset.id!, fd({ date, amount: 450 + Math.floor(rnd() * 250), fundingSource: "TREASURY" })),
        "ad spend",
      );
    }
    const n = Math.max(0, Math.round(opts.ordersPerDay + (rnd() - 0.5) * 2));
    for (let k = 0; k < n; k++) {
      const lines: { productVariantId: string; quantity: number; unitPrice: number; discount: number }[] = [];
      const nLines = 1 + Math.floor(rnd() * 3);
      const used = new Set<string>();
      for (let l = 0; l < nLines; l++) {
        const v = pick(variants);
        if (used.has(v.id)) continue;
        used.add(v.id);
        lines.push({
          productVariantId: v.id,
          quantity: 1 + Math.floor(rnd() * 2),
          unitPrice: Number(v.salePrice),
          discount: rnd() < 0.15 ? 50 : 0,
        });
      }
      const inDhaka = rnd() < 0.55;
      const useCourier = rnd() < 0.8;
      const paidUpfront = rnd() < 0.25;
      const res = await createOrder(
        slug,
        fd({
          customerId: pick(customerIds),
          date,
          status: "CONFIRMED",
          deliveryType: useCourier ? "COURIER" : "SELF",
          deliveryCharge: useCourier ? (inDhaka ? 80 : 130) : 0,
          courierId: useCourier ? courier.id : undefined,
          courierZoneId: useCourier ? zone(inDhaka ? "Inside Dhaka" : "Outside Dhaka").id : undefined,
          weightKg: useCourier ? 0.5 + Math.floor(rnd() * 3) * 0.5 : undefined,
          paymentMethod: paidUpfront ? "BKASH" : useCourier ? "COURIER_COLLECTION" : "CASH",
          paymentStatus: paidUpfront ? "PAID" : "UNPAID",
          packagingCost: 12,
          discount: rnd() < 0.1 ? 100 : 0,
          items: lines,
        }),
      );
      if (!res.ok) continue; // out of stock on a busy day is a normal outcome
      orderIds.push({ id: (res as Res).id!, status: "CONFIRMED", date });
    }
  }

  // ── lifecycle: ship, deliver, collect, cancel, return ──────────────
  const delivered: string[] = [];
  for (let i = 0; i < orderIds.length; i++) {
    const o = orderIds[i];
    const roll = rnd();
    if (i >= orderIds.length - 4) {
      // the newest few stay pending/confirmed
      if (roll < 0.5) must(await updateOrderStatus(slug, o.id, "PENDING"), "pending");
      continue;
    }
    must(await updateOrderStatus(slug, o.id, "SHIPPED"), "ship");
    if (roll < 0.82) {
      must(await updateOrderStatus(slug, o.id, "DELIVERED"), "deliver");
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { paymentStatus: true } });
      if (row.paymentStatus !== "PAID") {
        const t = await prisma.order.findUniqueOrThrow({
          where: { id: o.id },
          include: { items: { include: { returns: true } } },
        });
        const total =
          t.items.reduce((s, it) => s + Number(it.unitPrice) * it.quantity - Number(it.discount), 0) -
          Number(t.discount) +
          Number(t.deliveryCharge);
        must(await recordPayment(slug, o.id, Math.round(total * 100) / 100), "collect");
      }
      delivered.push(o.id);
    } else if (roll < 0.93) {
      must(
        await updateOrderStatus(slug, o.id, "CANCELLED", {
          deliveryCost: 40,
          cancelledCollected: 0,
          goodsInTransit: false,
        } as never),
        "cancel",
      );
    }
  }

  // a few returns on delivered orders
  for (const id of delivered.filter((_, i) => i % 11 === 3)) {
    const item = await prisma.orderItem.findFirst({ where: { orderId: id }, include: { returns: true } });
    if (!item || item.returns.length > 0) continue;
    await createReturn(slug, fd({ orderItemId: item.id, quantity: 1, refundAmount: Number(item.unitPrice), reason: "Size / quality", goodsInTransit: "false" }));
  }

  // bank the delivered cash into the treasury in one go
  await markAllCashDeposited(slug, delivered);

  // one profit distribution, sized well under profit
  await createTreasuryEntry(slug, fd({ type: "IN", amount: 5000, source: "Stall sales (cash)", date: addDays(d0, opts.days - 2) }));
  await createDistribution(slug, fd({ amount: 8000, note: "Monthly profit share", date: addDays(d0, opts.days - 1) }));

  await actAs(null);
  return {
    workspaceId: ws.id,
    slug,
    users: { owner: owner.id, partnerA: partnerA.id, partnerB: partnerB.id, manager: manager.id, staff: staff.id },
    emails: {
      owner: email("owner"),
      partnerA: email("partner.rafi"),
      partnerB: email("partner.mim"),
      manager: email("manager"),
      staff: email("staff"),
    },
  };
}
