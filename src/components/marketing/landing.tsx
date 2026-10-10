import Link from "next/link";
import { OrderSlip } from "@/components/marketing/order-slip";
import { PricingTable } from "@/components/marketing/pricing-table";
import { SiteFooter, SiteHeader } from "@/components/marketing/site-chrome";
import { PLANS, SELLABLE, TRIAL_DAYS, priceFor } from "@/lib/plans";

export const marketingPlans = SELLABLE.map((k) => ({
  key: k,
  name: PLANS[k].name,
  tagline: PLANS[k].tagline,
  highlights: PLANS[k].highlights,
  monthly: priceFor(k, "MONTHLY"),
  yearly: priceFor(k, "YEARLY"),
  featured: k === "BUSINESS",
}));

const MONEY_PATH = [
  {
    title: "You sell",
    body: "The order is recorded and the pieces leave the shelf. You cannot sell what you do not have.",
  },
  {
    title: "The courier carries it",
    body: "Your rate card prices the delivery and the cash-on-delivery fee the moment you book.",
  },
  {
    title: "The rider collects",
    body: "The app already knows what the courier keeps and what will actually reach you.",
  },
  {
    title: "Cash reaches the treasury",
    body: "Mark it banked and the treasury moves once, by the right amount — no double counting.",
  },
  {
    title: "Partners are paid",
    body: "Profit is split by share. Capital, expenses and withdrawals stay separate from it.",
  },
];

const FOR_SHOPS = [
  {
    term: "Cash on delivery, done properly",
    text: "Delivery bill, percentage fee, part-payments and parcels the customer refused — each one lands where it belongs.",
  },
  {
    term: "Returns that put stock back",
    text: "A returned or cancelled parcel only goes back on the shelf when it has actually come back.",
  },
  {
    term: "Partners who share a shop",
    text: "Who put money in, who spent their own, who took profit out — and what each is still owed.",
  },
  {
    term: "Ads that pay for themselves, or do not",
    text: "Tag orders to a campaign and see profit after the ad spend, not just sales.",
  },
  {
    term: "Your website's orders, in a call list",
    text: "Orders and abandoned checkouts from WooCommerce arrive ready to phone, with fraud checks on the number.",
  },
  {
    term: "Works when the signal does not",
    text: "Install it on a phone. Orders entered offline are saved and sent once, when you are back online.",
  },
];

const FAQ = [
  {
    q: "Do I need a card to start?",
    a: `No. Every account starts with a ${TRIAL_DAYS}-day trial of the Business plan. You pay later, by bKash, Nagad or bank transfer, only if you want to continue.`,
  },
  {
    q: "What happens if I stop paying?",
    a: "The workspace becomes read-only after a short grace period. Nothing is deleted: you can still look at everything, download a backup and renew whenever you like.",
  },
  {
    q: "Can I get my data out?",
    a: "Yes, at any time. Owners can download a full backup, and a copy can also go to your own Google Drive.",
  },
  {
    q: "Is it only for baby products?",
    a: "No. It was built for a baby-products shop, but products, variants, couriers and partners are set up by you. Any shop that stocks goods and ships them will fit.",
  },
  {
    q: "Which couriers does it support?",
    a: "Courier rate cards are built in for any courier you set up, with live booking and status updates for Steadfast.",
  },
  {
    q: "Who can see my business?",
    a: "Only the people you invite, with the access you give them. Each workspace is completely separate from every other.",
  },
];

export function Landing({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <SiteHeader signedIn={signedIn} />

      <main>
        {/* Hero: the claim, and the proof next to it. */}
        <section className="mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-14 md:grid-cols-[1.05fr_0.95fr] md:items-center md:pt-20">
          <div>
            <h1 className="font-display text-5xl font-bold leading-[1.02] tracking-tight sm:text-6xl">
              Every order, down to the last taka.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-ink/75">
              GeduSuite keeps your stock, courier cash, ad spend and partner profit in one book, so
              the figure on the dashboard is the figure in the bank.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href={signedIn ? "/" : "/register"}
                className="rounded-md bg-ink px-5 py-3 font-medium text-paper hover:bg-ink/90"
              >
                {signedIn ? "Open my workspaces" : `Start your ${TRIAL_DAYS}-day free trial`}
              </Link>
              <Link
                href="/pricing"
                className="rounded-md border border-ink/30 px-5 py-3 font-medium hover:border-ink"
              >
                See pricing
              </Link>
            </div>
            <p className="mt-4 text-sm text-ink/60">
              No card needed. Built by a working online shop in Bangladesh.
            </p>
          </div>
          <div className="flex justify-center md:justify-end">
            <OrderSlip />
          </div>
        </section>

        {/* What it replaces. */}
        <section className="border-y border-ink/10 bg-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-2">
            <div>
              <h2 className="font-display text-3xl font-semibold tracking-tight">
                The notebook, the spreadsheet and the courier&apos;s app, in disagreement
              </h2>
              <p className="mt-4 max-w-lg leading-7 text-ink/75">
                Stock is in one place, what the courier owes you in another, what each partner has
                put in in a third. Month-end is spent making them agree.
              </p>
            </div>
            <ul className="space-y-4 text-ink/85">
              <li className="border-l-2 border-stamp pl-4">
                &ldquo;The courier statement says ৳41,200. My sheet says ৳43,650. Who is right?&rdquo;
              </li>
              <li className="border-l-2 border-stamp pl-4">
                &ldquo;We sold six of those. The shelf has two. Where did the others go?&rdquo;
              </li>
              <li className="border-l-2 border-stamp pl-4">
                &ldquo;Did the ad make money, or did it only make sales?&rdquo;
              </li>
              <li className="border-l-2 border-teal pl-4 font-medium">
                One book. Each figure is worked out in exactly one place, so every screen shows the
                same answer.
              </li>
            </ul>
          </div>
        </section>

        {/* The sequence. Numbered because it genuinely is one. */}
        <section id="how" className="mx-auto max-w-6xl px-5 py-20">
          <h2 className="max-w-2xl font-display text-3xl font-semibold tracking-tight">
            Follow one parcel from the shelf to your partners
          </h2>
          <ol className="mt-10 grid gap-x-6 gap-y-8 md:grid-cols-5">
            {MONEY_PATH.map((s, i) => (
              <li key={s.title} className="relative border-t-2 border-ink pt-4">
                <span className="font-display text-sm font-semibold text-ink/55">Step {i + 1}</span>
                <h3 className="mt-1 font-display text-lg font-semibold leading-snug">{s.title}</h3>
                <p className="mt-2 text-sm leading-6 text-ink/70">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* What is specific to how small shops here actually sell. */}
        <section className="bg-ink text-paper">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="max-w-2xl font-display text-3xl font-semibold tracking-tight">
              Made for shops that sell on Facebook, WhatsApp and a small website
            </h2>
            <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
              {FOR_SHOPS.map((f) => (
                <div key={f.term} className="border-t border-paper/20 pt-4">
                  <dt className="font-display text-lg font-semibold">{f.term}</dt>
                  <dd className="mt-1.5 leading-7 text-paper/75">{f.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-6xl px-5 py-20">
          <h2 className="font-display text-3xl font-semibold tracking-tight">
            Priced for a shop, not an enterprise
          </h2>
          <div className="mt-8">
            <PricingTable plans={marketingPlans} trialDays={TRIAL_DAYS} />
          </div>
        </section>

        <section className="border-t border-ink/10 bg-white">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-[0.8fr_1.2fr]">
            <h2 className="font-display text-3xl font-semibold tracking-tight">Questions</h2>
            <div className="divide-y divide-ink/10 border-y border-ink/10">
              {FAQ.map((f) => (
                <details key={f.q} className="group py-4">
                  <summary className="cursor-pointer list-none font-medium marker:hidden">
                    <span className="flex items-start justify-between gap-4">
                      {f.q}
                      <span aria-hidden className="text-ink/50 group-open:rotate-45">
                        +
                      </span>
                    </span>
                  </summary>
                  <p className="mt-2 max-w-2xl leading-7 text-ink/75">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-20">
          <div className="flex flex-wrap items-center justify-between gap-6 border border-ink p-8 sm:p-12">
            <h2 className="max-w-xl font-display text-3xl font-semibold tracking-tight">
              Put this month&apos;s orders through it and see if it adds up.
            </h2>
            <Link
              href={signedIn ? "/" : "/register"}
              className="rounded-md bg-ink px-5 py-3 font-medium text-paper hover:bg-ink/90"
            >
              {signedIn ? "Open my workspaces" : `Start your ${TRIAL_DAYS}-day free trial`}
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
