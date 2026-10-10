"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { approvePayment, rejectPayment } from "@/server/actions/admin";

export function PaymentReviewRow({
  invoice,
}: {
  invoice: {
    id: string;
    number: number;
    workspace: string;
    plan: string;
    cycle: string;
    amount: number;
    method: string | null;
    senderNumber: string | null;
    trxId: string | null;
    note: string | null;
    submittedAt: string | null;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">
          INV-{String(invoice.number).padStart(5, "0")} · {invoice.workspace}
        </div>
        <div className="text-lg font-bold tabular-nums">৳{invoice.amount.toLocaleString("en")}</div>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          Plan: {invoice.plan} · {invoice.cycle === "YEARLY" ? "yearly" : "monthly"}
        </div>
        <div>Method: {invoice.method}</div>
        <div>
          Transaction ID: <span className="font-mono">{invoice.trxId}</span>
        </div>
        <div>From: {invoice.senderNumber || "—"}</div>
        {invoice.note ? <div className="sm:col-span-2">Note: {invoice.note}</div> : null}
        <div className="text-xs text-muted-foreground sm:col-span-2">
          Submitted {invoice.submittedAt?.slice(0, 16).replace("T", " ")}
        </div>
      </dl>
      {rejecting ? (
        <div className="flex flex-wrap gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason shown to the customer"
            className="h-9 min-w-64 flex-1 rounded-md border bg-background px-3 text-sm"
          />
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await rejectPayment(invoice.id, reason);
                if (!res.ok) toast.error(res.error);
                else {
                  toast.success("Rejected");
                  router.refresh();
                }
              })
            }
          >
            Confirm reject
          </Button>
          <Button variant="ghost" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await approvePayment(invoice.id);
                if (!res.ok) toast.error(res.error);
                else {
                  toast.success("Approved — plan activated");
                  router.refresh();
                }
              })
            }
          >
            Approve &amp; activate
          </Button>
          <Button variant="outline" onClick={() => setRejecting(true)}>
            Reject…
          </Button>
        </div>
      )}
    </div>
  );
}
