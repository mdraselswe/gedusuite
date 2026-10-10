import { prisma } from "@/lib/prisma";

/** Past this many orders a shop does not need a checklist. */
const ESTABLISHED_ORDERS = 20;

export type OnboardingStep = {
  key: string;
  label: string;
  hint: string;
  href: string;
  done: boolean;
  /** Nice to have, not needed before the first sale. */
  optional: boolean;
};

export type Onboarding = {
  steps: OnboardingStep[];
  /** Required steps finished / total. */
  progress: { done: number; total: number };
  /** Worth showing at all: new enough, and not finished. */
  show: boolean;
};

/**
 * A new workspace's way in: the few things that must exist before an order can
 * be recorded properly, in the order they are needed.
 *
 * Worked out from what is actually in the database, so it can never disagree
 * with reality or need a "mark as done" click — and it disappears for good
 * once the shop is clearly up and running, which includes every workspace that
 * existed before this was added.
 */
export async function onboardingFor(workspaceId: string, slug: string): Promise<Onboarding> {
  // One cheap indexed count settles it for every established shop, so the
  // dashboard of a busy workspace pays for a single query, not eight.
  const orders = await prisma.order.count({ where: { workspaceId } });
  if (orders >= ESTABLISHED_ORDERS) {
    return { steps: [], progress: { done: 0, total: 0 }, show: false };
  }

  const [products, purchases, couriers, partners, members, ws] = await Promise.all([
    prisma.product.count({ where: { workspaceId } }),
    prisma.purchase.count({ where: { workspaceId } }),
    prisma.courier.count({ where: { workspaceId } }),
    prisma.partner.count({ where: { workspaceId } }),
    prisma.membership.count({ where: { workspaceId } }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { logoUrl: true, websiteUrl: true },
    }),
  ]);

  const steps: OnboardingStep[] = [
    {
      key: "product",
      label: "Add your first product",
      hint: "Name, sizes or colours, and what you sell it for.",
      href: `/${slug}/products`,
      done: products > 0,
      optional: false,
    },
    {
      key: "purchase",
      label: "Record what you bought",
      hint: "Quantity and cost — this is what puts stock on the shelf.",
      href: `/${slug}/purchases`,
      done: purchases > 0,
      optional: false,
    },
    {
      key: "order",
      label: "Enter your first order",
      hint: "Stock, profit and cash all start moving from here.",
      href: `/${slug}/sales/orders`,
      done: orders > 0,
      optional: false,
    },
    {
      key: "courier",
      label: "Set up your courier's rates",
      hint: "So delivery costs and cash-on-delivery fees are worked out for you.",
      href: `/${slug}/couriers`,
      done: couriers > 0,
      optional: true,
    },
    {
      key: "partners",
      label: "Add the partners who share the profit",
      hint: "Only if the shop is owned by more than one person.",
      href: `/${slug}/partners`,
      done: partners > 0,
      optional: true,
    },
    {
      key: "team",
      label: "Invite your team",
      hint: "Give each person only the access they need.",
      href: `/${slug}/settings/team`,
      done: members > 1,
      optional: true,
    },
    {
      key: "brand",
      label: "Add your logo and website",
      hint: "They appear on invoices and printed order forms.",
      href: `/${slug}/settings/appearance`,
      done: Boolean(ws?.logoUrl || ws?.websiteUrl),
      optional: true,
    },
  ];

  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  // Shops past their first few dozen orders know their way around.
  const show = steps.some((s) => !s.done);
  return { steps, progress: { done, total: required.length }, show };
}
