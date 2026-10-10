"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  cancelPaymentRequest,
  startCheckout,
  submitPaymentProof,
} from "@/server/actions/billing";

type Cycle = "MONTHLY" | "YEARLY";

type Props = {
  slug: string;
  enforced: boolean;
  current: {
    planKey: string;
    planName: string;
    state: "active" | "trial" | "grace" | "readonly";
    status: string;
    daysLeft: number | null;
    until: string | null;
    cycle: string | null;
  };
  limits: Record<"members" | "ordersPerMonth" | "products" | "couriers", number | null>;
  usage: Record<"members" | "ordersPerMonth" | "products" | "couriers", number>;
  plans: {
    key: string;
    name: string;
    tagline: string;
    highlights: string[];
    monthly: number;
    yearly: number;
  }[];
  instructions: {
    bkash: string | null;
    nagad: string | null;
    bank: string | null;
    supportPhone: string | null;
    supportEmail: string | null;
  };
  invoices: {
    id: string;
    number: number;
    planName: string;
    cycle: string;
    amount: number;
    status: string;
    submitted: boolean;
    trxId: string | null;
    rejectReason: string | null;
    createdAt: string;
  }[];
};

const taka = (n: number) => `৳${n.toLocaleString("en")}`;
const METRICS: { key: keyof Props["usage"]; label: string }[] = [
  { key: "members", label: "Team members" },
  { key: "ordersPerMonth", label: "Orders this month" },
  { key: "products", label: "Products" },
  { key: "couriers", label: "Couriers" },
];

const STATE_LABEL: Record<Props["current"]["state"], string> = {
  active: "Active",
  trial: "Free trial",
  grace: "Payment due",
  readonly: "Read-only",
};

export function BillingPanel(p: Props) {
  const router = useRouter();
  const [cycle, setCycle] = useState<Cycle>("MONTHLY");
  const [pending, start] = useTransition();
  const [paying, setPaying] = useState<string | null>(
    p.invoices.find((i) => i.status === "PENDING" && !i.submitted)?.id ?? null,
  );

  function choose(plan: string) {
    start(async () => {
      const f = new FormData();
      f.set("plan", plan);
      f.set("cycle", cycle);
      const res = await startCheckout(p.slug, f);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setPaying(res.invoiceId);
      router.refresh();
    });
  }

  function submitProof(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    f.set("invoiceId", paying!);
    start(async () => {
      const res = await submitPaymentProof(p.slug, f);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Thanks — we will confirm your payment shortly.");
      setPaying(null);
      router.refresh();
    });
  }

  const payingInvoice = p.invoices.find((i) => i.id === paying);
  const warn = p.current.state === "grace" || p.current.state === "readonly";

  return (
    <div className="space-y-6">
      {!p.enforced ? (
        <p className="rounded-lg border bg-muted/40 p-3 text-sm">
          Plan limits are not being applied to this workspace yet. You can look around and pay in
          advance, but nothing will be restricted.
        </p>
      ) : null}

      <Card className={warn ? "border-destructive/40" : undefined}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {p.current.planName}
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
              {STATE_LABEL[p.current.state]}
            </span>
          </CardTitle>
          <CardDescription>
            {p.current.planKey === "LEGACY"
              ? "Your workspace is a founding workspace: everything is included and nothing expires."
              : p.current.until
                ? `${p.current.status === "TRIALING" ? "Trial ends" : "Paid until"} ${p.current.until.slice(0, 10)}${
                    p.current.daysLeft !== null ? ` — ${p.current.daysLeft} day(s) left` : ""
                  }`
                : "No end date set"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {METRICS.map((m) => {
            const limit = p.limits[m.key];
            const used = p.usage[m.key];
            const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
            return (
              <div key={m.key} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span>{m.label}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {used.toLocaleString("en")} / {limit === null ? "Unlimited" : limit.toLocaleString("en")}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${pct >= 100 ? "bg-destructive" : pct >= 80 ? "bg-amber-500" : "bg-primary"}`}
                    style={{ width: `${limit === null ? 4 : Math.max(pct, 2)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Choose a plan</h2>
          <div className="inline-flex rounded-lg border p-0.5 text-sm">
            {(["MONTHLY", "YEARLY"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCycle(c)}
                className={`rounded-md px-3 py-1 ${cycle === c ? "bg-primary text-primary-foreground" : ""}`}
              >
                {c === "MONTHLY" ? "Monthly" : "Yearly · 2 months free"}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {p.plans.map((pl) => (
            <Card key={pl.key} className={pl.key === p.current.planKey ? "border-primary" : undefined}>
              <CardHeader>
                <CardTitle>{pl.name}</CardTitle>
                <CardDescription>{pl.tagline}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <span className="text-2xl font-bold tabular-nums">
                    {taka(cycle === "MONTHLY" ? pl.monthly : pl.yearly)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {cycle === "MONTHLY" ? " / month" : " / year"}
                  </span>
                </div>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {pl.highlights.map((h) => (
                    <li key={h}>✓ {h}</li>
                  ))}
                </ul>
                <Button
                  className="w-full"
                  variant={pl.key === p.current.planKey && p.current.state === "active" ? "outline" : "default"}
                  disabled={pending}
                  onClick={() => choose(pl.key)}
                >
                  {pl.key === p.current.planKey && p.current.state === "active" ? "Renew / extend" : "Choose " + pl.name}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {payingInvoice ? (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle>
              Pay {taka(payingInvoice.amount)} for {payingInvoice.planName} (
              {payingInvoice.cycle === "YEARLY" ? "yearly" : "monthly"})
            </CardTitle>
            <CardDescription>
              Send the amount, then enter the transaction ID from your payment message. We confirm
              it and your plan starts — usually within a few hours.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="space-y-1 text-sm">
              {p.instructions.bkash ? <li>bKash (send money): <strong>{p.instructions.bkash}</strong></li> : null}
              {p.instructions.nagad ? <li>Nagad (send money): <strong>{p.instructions.nagad}</strong></li> : null}
              {p.instructions.bank ? <li>Bank: <strong>{p.instructions.bank}</strong></li> : null}
              {!p.instructions.bkash && !p.instructions.nagad && !p.instructions.bank ? (
                <li className="text-muted-foreground">
                  Payment details are not set up yet — contact support
                  {p.instructions.supportEmail ? ` at ${p.instructions.supportEmail}` : ""}.
                </li>
              ) : null}
            </ul>
            <form onSubmit={submitProof} className="grid gap-3 sm:grid-cols-2">
              <Field name="method" label="Paid with" required>
                <select
                  id="method"
                  name="method"
                  required
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  defaultValue="BKASH"
                >
                  <option value="BKASH">bKash</option>
                  <option value="NAGAD">Nagad</option>
                  <option value="BANK">Bank transfer</option>
                </select>
              </Field>
              <Field name="senderNumber" label="Number you paid from">
                <Input id="senderNumber" name="senderNumber" inputMode="tel" placeholder="01XXXXXXXXX" />
              </Field>
              <div className="sm:col-span-2">
                <Field name="trxId" label="Transaction ID" required>
                  <Input id="trxId" name="trxId" required placeholder="e.g. 9AB12CD34E" autoComplete="off" />
                </Field>
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={pending}>
                  {pending ? "Sending…" : "I have paid"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await cancelPaymentRequest(p.slug, payingInvoice.id);
                      setPaying(null);
                      router.refresh();
                    })
                  }
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {p.invoices.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Payment history</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3">#</th>
                    <th className="py-1 pr-3">Date</th>
                    <th className="py-1 pr-3">Plan</th>
                    <th className="py-1 pr-3 text-right">Amount</th>
                    <th className="py-1 pr-3">Transaction</th>
                    <th className="py-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {p.invoices.map((i) => (
                    <tr key={i.id} className="border-t">
                      <td className="py-1.5 pr-3 tabular-nums">INV-{String(i.number).padStart(5, "0")}</td>
                      <td className="py-1.5 pr-3">{i.createdAt.slice(0, 10)}</td>
                      <td className="py-1.5 pr-3">
                        {i.planName} · {i.cycle === "YEARLY" ? "yearly" : "monthly"}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{taka(i.amount)}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{i.trxId ?? "—"}</td>
                      <td className="py-1.5">
                        {i.status === "PENDING"
                          ? i.submitted
                            ? "Awaiting confirmation"
                            : "Not paid yet"
                          : i.status === "PAID"
                            ? "Paid"
                            : i.status === "REJECTED"
                              ? `Rejected — ${i.rejectReason ?? ""}`
                              : "Cancelled"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
