"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { adminSetSubscription } from "@/server/actions/admin";

const PLAN_KEYS = ["STARTER", "BUSINESS", "PRO", "LEGACY"];

export function AdminTenantActions({
  workspaceId,
  planKey,
  status,
}: {
  workspaceId: string;
  planKey: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [plan, setPlan] = useState(planKey);

  function run(change: Parameters<typeof adminSetSubscription>[1], okMsg: string) {
    start(async () => {
      const res = await adminSetSubscription(workspaceId, change);
      if (!res.ok) toast.error(res.error);
      else {
        toast.success(okMsg);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <select
        value={plan}
        onChange={(e) => setPlan(e.target.value)}
        className="h-7 rounded border bg-background px-1"
        disabled={pending}
      >
        {PLAN_KEYS.map((k) => (
          <option key={k}>{k}</option>
        ))}
      </select>
      <button
        className="rounded border px-2 py-1"
        disabled={pending || plan === planKey}
        onClick={() => run({ planKey: plan }, "Plan changed")}
      >
        Set plan
      </button>
      <button
        className="rounded border px-2 py-1"
        disabled={pending}
        onClick={() => run({ extendDays: 7 }, "+7 days")}
      >
        +7d
      </button>
      <button
        className="rounded border px-2 py-1"
        disabled={pending}
        onClick={() => run({ extendDays: 30 }, "+30 days")}
      >
        +30d
      </button>
      {status === "SUSPENDED" ? (
        <button
          className="rounded border px-2 py-1"
          disabled={pending}
          onClick={() => run({ status: "ACTIVE" }, "Restored")}
        >
          Restore
        </button>
      ) : (
        <button
          className="rounded border border-destructive/40 px-2 py-1 text-destructive"
          disabled={pending}
          onClick={() => {
            if (confirm("Suspend this workspace? It becomes read-only.")) {
              run({ status: "SUSPENDED" }, "Suspended");
            }
          }}
        >
          Suspend
        </button>
      )}
    </div>
  );
}
