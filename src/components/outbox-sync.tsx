"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { flushQueue } from "@/lib/offline-queue";

/** Plain names for the queue's action types — "purchase.create" helps nobody. */
const LABELS: Record<string, string> = {
  "purchase.create": "purchase",
  "customer.create": "customer",
  "order.create": "order",
  "internalPurchase.create": "internal purchase",
  "partnerTxn.create": "partner transaction",
  "treasury.create": "treasury entry",
  "stockAdjustment.create": "stock adjustment",
  "boostSpend.create": "boost spend",
};

// Replays any queued offline mutations on load and whenever connectivity returns.
export function OutboxSync() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function flush() {
      try {
        const { flushed, rejected } = await flushQueue();
        if (cancelled) return;
        if (flushed > 0) {
          toast.success(`${flushed} offline change${flushed > 1 ? "s" : ""} synced`);
        }
        // A refused write is dropped from the queue because retrying it can't
        // help — but it used to be dropped silently too, so a purchase typed
        // offline could simply cease to exist between "queued" and never being
        // mentioned again. Each one gets said out loud, and stays on screen
        // long enough to be read and acted on.
        for (const r of rejected) {
          toast.error(`Offline ${LABELS[r.actionType] ?? r.actionType} was not saved: ${r.error}`, {
            duration: 15000,
          });
        }
        if (flushed > 0) router.refresh();
      } catch {
        // ignore — will retry on next online event
      }
    }
    flush();
    window.addEventListener("online", flush);
    return () => {
      cancelled = true;
      window.removeEventListener("online", flush);
    };
  }, [router]);

  return null;
}
