"use client";

import { useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckCircle2, PhoneCall } from "lucide-react";
import { useRouter } from "@/lib/live-router";
import { markCustomerReached } from "@/server/actions/customers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Money } from "@/components/ui/money";

export type CustomerFollowUpRow = {
  id: string;
  name: string;
  phone: string | null;
  altPhone: string | null;
  address: string | null;
  note: string | null;
  lastReachedDay: string | null;
  nextReachDay: string | null;
  daysUntilNext: number | null;
  orderCount: number;
  lifetime: number;
};

function dueLabel(row: CustomerFollowUpRow) {
  if (row.nextReachDay === null) return "Due now";
  if (row.daysUntilNext === null) return row.nextReachDay;
  if (row.daysUntilNext < 0) return `${Math.abs(row.daysUntilNext)} days overdue`;
  if (row.daysUntilNext === 0) return "Due today";
  if (row.daysUntilNext === 1) return "Tomorrow";
  return `In ${row.daysUntilNext} days`;
}

export function CustomerFollowUpManager({
  slug,
  rows,
  canEdit,
}: {
  slug: string;
  rows: CustomerFollowUpRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function markReached(row: CustomerFollowUpRow) {
    startTransition(async () => {
      const res = await markCustomerReached(slug, row.id, 30);
      if (!res.ok) {
        toast.error(res.error ?? "Failed");
        return;
      }
      toast.success("Marked reached. Next reach set after 30 days.");
      router.refresh();
    });
  }

  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      searchText={(r) => [r.name, r.phone, r.altPhone, r.address, r.note].filter(Boolean).join(" ")}
      searchPlaceholder="Search follow-ups..."
      empty={{
        icon: PhoneCall,
        title: "No follow-up customers",
        description: "Mark customers from the Customers page when they are worth reaching again.",
      }}
      rowTone={(r) =>
        r.daysUntilNext === null || r.daysUntilNext <= 0
          ? "bg-emerald-50/70 dark:bg-emerald-950/20"
          : undefined
      }
      columns={
        [
          {
            key: "name",
            header: "Customer",
            cardTitle: true,
            wrap: true,
            sortValue: (r) => r.name.toLowerCase(),
            cell: (r) => (
              <span>
                <Link href={`/${slug}/customers/${r.id}`} className="font-medium underline underline-offset-4">
                  {r.name}
                </Link>
                {(r.daysUntilNext === null || r.daysUntilNext <= 0) && (
                  <Badge variant="secondary" className="ml-2">
                    Due
                  </Badge>
                )}
              </span>
            ),
          },
          {
            key: "phone",
            header: "Phone",
            cell: (r) => (
              <span>
                {r.phone ?? "—"}
                {r.altPhone && (
                  <span className="block text-xs text-muted-foreground">{r.altPhone}</span>
                )}
              </span>
            ),
          },
          {
            key: "next",
            header: "Next reach",
            sortValue: (r) => r.daysUntilNext ?? -9999,
            cell: (r) => (
              <span>
                {r.nextReachDay ?? "not set"}
                <span className="block text-xs text-muted-foreground">{dueLabel(r)}</span>
              </span>
            ),
          },
          {
            key: "last",
            header: "Last reached",
            hideable: true,
            sortValue: (r) => r.lastReachedDay ?? "",
            cell: (r) => r.lastReachedDay ?? <span className="text-muted-foreground">never</span>,
          },
          {
            key: "history",
            header: "History",
            hideable: true,
            sortValue: (r) => r.orderCount,
            cell: (r) => (
              <span>
                {r.orderCount} orders
                {r.lifetime > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    <Money value={r.lifetime} />
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "note",
            header: "Note",
            wrap: true,
            cell: (r) => r.note ?? <span className="text-muted-foreground">—</span>,
          },
          {
            key: "actions",
            header: "",
            cardFullWidth: true,
            cell: (r) =>
              canEdit ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => markReached(r)}>
                  <CheckCircle2 data-icon="inline-start" />
                  Reached today
                </Button>
              ) : (
                <Link href={`/${slug}/customers/${r.id}`} className="text-sm underline underline-offset-4">
                  View
                </Link>
              ),
          },
        ] as Column<CustomerFollowUpRow>[]
      }
    />
  );
}
