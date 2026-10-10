import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { can, type Module, type Access } from "@/lib/rbac";
import { createProduct, deleteProduct } from "@/server/actions/products";
import { createPurchase } from "@/server/actions/purchases";
import { createOrder, updateOrderStatus, recordPayment, deleteOrder } from "@/server/actions/orders";
import { createCustomer, deleteCustomer } from "@/server/actions/customers";
import { createPartner } from "@/server/actions/partners";
import { createTreasuryEntry, deleteTreasuryEntry } from "@/server/actions/treasury";
import { createInternalPurchase } from "@/server/actions/internal-purchases";
import { createCampaign } from "@/server/actions/boosting";
import { updateMemberRole, removeMember } from "@/server/actions/team";
import { backupNow } from "@/server/actions/backup";
import { markCashDeposited } from "@/server/actions/cash-custody";
import { actAs, addMember, createUser, createWorkspaceWithOwner, fd, resetDatabase } from "./harness";

const DENIED = "You do not have permission to do that";
const slug = "role-shop";

type Probe = {
  name: string;
  module: Module;
  need: Access;
  run: () => Promise<{ ok: boolean; error?: string }>;
};

let variantId = "";
const users: Record<string, string> = {};

beforeAll(async () => {
  await resetDatabase();
  const owner = await createUser("owner@roles.test", "Owner");
  const ws = await createWorkspaceWithOwner("Role Shop", slug, owner.id);
  users.OWNER = owner.id;
  for (const role of ["PARTNER", "MANAGER", "STAFF"] as const) {
    const u = await createUser(`${role.toLowerCase()}@roles.test`, role);
    await addMember(ws.id, u.id, role);
    users[role] = u.id;
  }
  await actAs(owner.id);
  await createProduct(
    slug,
    fd({ name: "Seed Toy", lowStockThreshold: 1, variants: [{ attributes: [], salePrice: 100, unitCost: 60 }] }),
  );
  variantId = (await prisma.productVariant.findFirstOrThrow({ where: { product: { workspaceId: ws.id } } })).id;
});

const probes = (): Probe[] => [
  {
    name: "createProduct",
    module: "products",
    need: "add",
    run: () =>
      createProduct(slug, fd({ name: "P", lowStockThreshold: 1, variants: [{ attributes: [] }] })),
  },
  {
    name: "createPurchase",
    module: "purchases",
    need: "add",
    run: () => createPurchase(slug, fd({ productVariantId: variantId, date: "2026-09-01", unitCost: 1, quantity: 1 })),
  },
  {
    name: "createOrder",
    module: "sales",
    need: "add",
    run: () =>
      createOrder(
        slug,
        fd({
          date: "2026-09-01",
          status: "PENDING",
          deliveryType: "SELF",
          paymentMethod: "CASH",
          paymentStatus: "UNPAID",
          items: [{ productVariantId: variantId, quantity: 1, unitPrice: 100, discount: 0 }],
        }),
      ),
  },
  { name: "createCustomer", module: "customers", need: "add", run: () => createCustomer(slug, fd({ name: "C" })) },
  {
    name: "createPartner",
    module: "partners",
    need: "full",
    run: () => createPartner(slug, fd({ userId: users.STAFF, profitSharePercent: 10 })),
  },
  {
    name: "createTreasuryEntry",
    module: "treasury",
    need: "full",
    run: () => createTreasuryEntry(slug, fd({ type: "IN", amount: 10, source: "Test", date: "2026-09-01" })),
  },
  {
    name: "createInternalPurchase",
    module: "internal-purchases",
    need: "add",
    run: () =>
      createInternalPurchase(
        slug,
        fd({ itemName: "Tape", cost: 10, quantity: 1, category: "OTHER", date: "2026-09-01" }),
      ),
  },
  {
    name: "createCampaign",
    module: "boosting",
    need: "add",
    run: () => createCampaign(slug, fd({ name: "Camp", status: "ACTIVE" })),
  },
  { name: "backupNow", module: "backup", need: "full", run: () => backupNow(slug) },
];

describe("every role gets exactly what the permission matrix says", () => {
  for (const role of ["OWNER", "PARTNER", "MANAGER", "STAFF"] as const) {
    it(`${role}`, async () => {
      await actAs(users[role]);
      for (const p of probes()) {
        const res = await p.run();
        const allowed = can(role, p.module, p.need);
        if (allowed) {
          expect(res.error, `${role} should be allowed ${p.name}`).not.toBe(DENIED);
        } else {
          expect(res.ok, `${role} must not ${p.name}`).toBe(false);
          expect(res.error, `${role} ${p.name}`).toBe(DENIED);
        }
      }
    });
  }

  it("only the owner can change roles or remove members", async () => {
    const target = await prisma.membership.findFirstOrThrow({ where: { userId: users.STAFF } });
    for (const role of ["PARTNER", "MANAGER", "STAFF"] as const) {
      await actAs(users[role]);
      expect((await updateMemberRole(slug, target.id, "MANAGER")).ok).toBe(false);
      expect((await removeMember(slug, target.id)).ok).toBe(false);
    }
  });
});

describe("one workspace cannot touch another's records by id", () => {
  let aOrder = "";
  let aProduct = "";
  let aCustomer = "";
  let aTreasury = "";
  let aMembership = "";
  let bOwner = "";

  beforeAll(async () => {
    // Workspace A is "role-shop"; make a second, unrelated workspace B.
    const b = await createUser("owner@other-tenant.test", "Other Owner");
    await createWorkspaceWithOwner("Other Tenant", "other-tenant", b.id);
    bOwner = b.id;

    await actAs(users.OWNER);
    await createPurchase(slug, fd({ productVariantId: variantId, date: "2026-09-01", unitCost: 60, quantity: 20 }));
    const placed = await createOrder(
      slug,
      fd({
        date: "2026-09-02",
        status: "CONFIRMED",
        deliveryType: "SELF",
        paymentMethod: "CASH",
        paymentStatus: "UNPAID",
        items: [{ productVariantId: variantId, quantity: 1, unitPrice: 100, discount: 0 }],
      }),
    );
    aOrder = (placed as { id: string }).id;
    aProduct = (await prisma.product.findFirstOrThrow({ where: { name: "Seed Toy" } })).id;
    const c = await createCustomer(slug, fd({ name: "A's Customer", phone: "01711111111" }));
    aCustomer = (c as { id: string }).id;
    await createTreasuryEntry(slug, fd({ type: "IN", amount: 500, source: "Seed", date: "2026-09-01" }));
    aTreasury = (await prisma.treasuryEntry.findFirstOrThrow({ where: { source: "Seed" } })).id;
    aMembership = (await prisma.membership.findFirstOrThrow({ where: { userId: users.STAFF } })).id;
  });

  it("B's owner, acting through B's workspace, cannot read or change A's rows", async () => {
    await actAs(bOwner);
    // Every one of these names B's own slug (the only one they may use) with A's ids.
    const slugB = "other-tenant";
    const attempts = [
      await updateOrderStatus(slugB, aOrder, "CANCELLED"),
      await recordPayment(slugB, aOrder, 50),
      await deleteOrder(slugB, aOrder),
      await deleteProduct(slugB, aProduct),
      await deleteCustomer(slugB, aCustomer),
      await deleteTreasuryEntry(slugB, aTreasury),
      await updateMemberRole(slugB, aMembership, "OWNER"),
      await removeMember(slugB, aMembership),
      await markCashDeposited(slugB, aOrder),
    ];
    // deleteOrder and deleteCustomer are idempotent — an id that is not yours simply "is already
    // gone" and answers ok — so for it the proof is the row still existing,
    // checked below, not the return value.
    attempts.forEach((r, i) => {
      if (i === 2 || i === 4) return; // idempotent deletes: see below
      expect(r.ok, `attempt ${i}: ${JSON.stringify(r)}`).toBe(false);
    });

    // And nothing moved.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: aOrder } });
    expect(order.status).toBe("CONFIRMED");
    expect(order.workspaceId).not.toBe((await prisma.workspace.findFirstOrThrow({ where: { slug: "other-tenant" } })).id);
    expect(await prisma.product.count({ where: { id: aProduct } })).toBe(1);
    expect(await prisma.customer.count({ where: { id: aCustomer } })).toBe(1);
    expect(await prisma.treasuryEntry.count({ where: { id: aTreasury } })).toBe(1);
    const m = await prisma.membership.findUniqueOrThrow({ where: { id: aMembership } });
    expect(m.role).toBe("STAFF");
  });

  it("B's owner cannot use A's slug at all", async () => {
    await actAs(bOwner);
    const r = await createCustomer(slug, fd({ name: "Intruder" }));
    expect(r.ok).toBe(false);
    expect(await prisma.customer.count({ where: { name: "Intruder" } })).toBe(0);
  });
});
