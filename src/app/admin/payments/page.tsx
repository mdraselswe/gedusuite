import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { PLANS } from "@/lib/plans";
import { PaymentReviewRow } from "@/components/admin/payment-review";

export const dynamic = "force-dynamic";

export default async function AdminPayments() {
  await requirePlatformAdmin();
  const [waiting, recent] = await Promise.all([
    prisma.billingInvoice.findMany({
      where: { status: "PENDING", submittedAt: { not: null } },
      orderBy: { submittedAt: "asc" },
      include: { workspace: { select: { name: true, slug: true } } },
    }),
    prisma.billingInvoice.findMany({
      where: { status: { in: ["PAID", "REJECTED"] } },
      orderBy: { reviewedAt: "desc" },
      take: 30,
      include: { workspace: { select: { name: true, slug: true } } },
    }),
  ]);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Payments</h1>
        <Link href="/admin" className="rounded-md border px-3 py-1.5 text-sm">
          ← Workspaces
        </Link>
      </header>

      <section className="space-y-2">
        <h2 className="font-semibold">Waiting for confirmation ({waiting.length})</h2>
        {waiting.length === 0 ? (
          <p className="rounded-lg border p-4 text-sm text-muted-foreground">Nothing waiting.</p>
        ) : (
          waiting.map((i) => (
            <PaymentReviewRow
              key={i.id}
              invoice={{
                id: i.id,
                number: i.number,
                workspace: `${i.workspace.name} (/${i.workspace.slug})`,
                plan: PLANS[i.planKey as keyof typeof PLANS]?.name ?? i.planKey,
                cycle: i.cycle,
                amount: Number(i.amount),
                method: i.method,
                senderNumber: i.senderNumber,
                trxId: i.trxId,
                note: i.note,
                submittedAt: i.submittedAt?.toISOString() ?? null,
              }}
            />
          ))
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Recently settled</h2>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <tbody>
              {recent.map((i) => (
                <tr key={i.id} className="border-t first:border-t-0">
                  <td className="p-2 tabular-nums">INV-{String(i.number).padStart(5, "0")}</td>
                  <td className="p-2">{i.workspace.name}</td>
                  <td className="p-2 text-right tabular-nums">৳{Number(i.amount).toLocaleString("en")}</td>
                  <td className="p-2 font-mono text-xs">{i.trxId}</td>
                  <td className="p-2">{i.status === "PAID" ? "Paid" : `Rejected — ${i.rejectReason}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
