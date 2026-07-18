"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { flushQueue } from "@/lib/offline-queue";

// Replays any queued offline mutations on load and whenever connectivity returns.
export function OutboxSync() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function flush() {
      try {
        const n = await flushQueue();
        if (!cancelled && n > 0) {
          toast.success(`${n} offline change${n > 1 ? "s" : ""} synced`);
          router.refresh();
        }
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
