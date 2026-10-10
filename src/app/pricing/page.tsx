import type { Metadata } from "next";
import { display } from "@/components/marketing/fonts";
import { PricingTable } from "@/components/marketing/pricing-table";
import { SiteFooter, SiteHeader } from "@/components/marketing/site-chrome";
import { marketingPlans } from "@/components/marketing/landing";
import { METRIC_LABEL, PLANS, SELLABLE, TRIAL_DAYS } from "@/lib/plans";
import { auth } from "@/lib/session";

export const metadata: Metadata = {
  title: "Pricing — GeduSuite",
  description: "Simple monthly and yearly plans for small online shops. Start with a free trial.",
};

const ROWS: { label: string; get: (k: (typeof SELLABLE)[number]) => string }[] = [
  {
    label: "Team members",
    get: (k) => String(PLANS[k].limits.members ?? "Unlimited"),
  },
  {
    label: "Orders per month",
    get: (k) => (PLANS[k].limits.ordersPerMonth ?? "Unlimited").toLocaleString("en"),
  },
  {
    label: "Products",
    get: (k) => (PLANS[k].limits.products ?? "Unlimited").toLocaleString("en"),
  },
  {
    label: "Couriers",
    get: (k) => String(PLANS[k].limits.couriers ?? "Unlimited"),
  },
  { label: "WooCommerce website connection", get: (k) => (PLANS[k].website ? "Included" : "—") },
];

export default async function PricingPage() {
  const session = await auth();
  return (
    <div className={`${display.variable} min-h-screen bg-paper text-ink`}>
      <SiteHeader signedIn={Boolean(session?.user?.id)} />
      <main className="mx-auto max-w-6xl space-y-16 px-5 py-14">
        <div className="max-w-2xl">
          <h1 className="font-display text-4xl font-bold tracking-tight sm:text-5xl">
            Pick a plan. Change it when the shop grows.
          </h1>
          <p className="mt-4 text-lg leading-8 text-ink/75">
            Every plan keeps your stock, orders, courier cash and partner profit in one book. The
            difference is how many people, orders and couriers you need.
          </p>
        </div>

        <PricingTable plans={marketingPlans} trialDays={TRIAL_DAYS} />

        <section aria-labelledby="compare">
          <h2 id="compare" className="font-display text-2xl font-semibold">
            What each plan allows
          </h2>
          <div className="mt-5 overflow-x-auto border border-ink/15 bg-white">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-ink/15 text-left">
                  <th className="p-3 font-medium text-ink/60">&nbsp;</th>
                  {SELLABLE.map((k) => (
                    <th key={k} className="p-3 font-display font-semibold">
                      {PLANS[k].name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.label} className="border-b border-ink/10 last:border-0">
                    <th scope="row" className="p-3 text-left font-normal">
                      {r.label}
                    </th>
                    {SELLABLE.map((k) => (
                      <td key={k} className="p-3 tabular-nums">
                        {r.get(k)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-ink/60">
            Team members include people you have invited but who have not yet joined. Limits count{" "}
            {METRIC_LABEL.ordersPerMonth} by the order date, on Dhaka time.
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
