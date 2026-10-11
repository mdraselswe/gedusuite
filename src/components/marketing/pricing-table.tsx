"use client";

import { useState } from "react";
import Link from "next/link";

type PlanCard = {
  key: string;
  name: string;
  tagline: string;
  highlights: string[];
  monthly: number;
  yearly: number;
  featured?: boolean;
};

const taka = (n: number) => `৳${n.toLocaleString("en")}`;

export function PricingTable({ plans, trialDays }: { plans: PlanCard[]; trialDays: number }) {
  const [yearly, setYearly] = useState(false);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3 text-sm">
        <div role="tablist" className="inline-flex rounded-md border border-ink/20 p-0.5">
          <button
            role="tab"
            aria-selected={!yearly}
            onClick={() => setYearly(false)}
            className={`rounded px-3 py-1.5 ${!yearly ? "bg-ink text-paper" : "text-ink/70"}`}
          >
            Monthly
          </button>
          <button
            role="tab"
            aria-selected={yearly}
            onClick={() => setYearly(true)}
            className={`rounded px-3 py-1.5 ${yearly ? "bg-ink text-paper" : "text-ink/70"}`}
          >
            Yearly
          </button>
        </div>
        <span className="text-ink/65">Pay for ten months, get twelve.</span>
      </div>

      <div className="grid items-stretch gap-5 md:grid-cols-3">
        {plans.map((p) => (
          <section
            key={p.key}
            className={`flex flex-col rounded-xl border bg-white p-6 transition duration-300 hover:-translate-y-1 hover:shadow-xl ${
              p.featured
                ? "border-violet-400 shadow-lg shadow-violet-500/20 ring-2 ring-violet-400/40 md:-mt-3 md:pb-9"
                : "border-ink/15"
            }`}
          >
            <h3 className="font-display text-xl font-semibold">{p.name}</h3>
            <p className="mt-1 min-h-10 text-sm text-ink/65">{p.tagline}</p>
            <p className="mt-5 flex items-baseline gap-1">
              <span className="font-display text-4xl font-bold tabular-nums">
                {taka(yearly ? p.yearly : p.monthly)}
              </span>
              <span className="text-sm text-ink/60">{yearly ? "a year" : "a month"}</span>
            </p>
            {yearly ? (
              <p className="mt-1 text-xs text-ink/55">
                That is {taka(Math.round(p.yearly / 12))} a month.
              </p>
            ) : (
              <p className="mt-1 text-xs text-ink/55">Cancel any time.</p>
            )}
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              {p.highlights.map((h) => (
                <li key={h} className="flex gap-2">
                  <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-violet-500" />
                  {h}
                </li>
              ))}
            </ul>
            <Link
              href="/register"
              className={`mt-6 block rounded-md px-4 py-2.5 text-center text-sm font-medium ${
                p.featured
                  ? "btn-sheen bg-brand-gradient text-white shadow-md shadow-violet-500/40 hover:brightness-110"
                  : "border border-ink/30 hover:border-ink hover:bg-ink/5"
              }`}
            >
              Try {p.name} free for {trialDays} days
            </Link>
          </section>
        ))}
      </div>
      <p className="text-sm text-ink/60">
        Every trial includes the Business plan. No card needed — you pay later by bKash, Nagad or
        bank transfer, only if you decide to continue.
      </p>
    </div>
  );
}
