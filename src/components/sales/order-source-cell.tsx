"use client";

import { useState } from "react";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import { setOrderSource } from "@/server/actions/orders";
import {
  ORDER_SOURCES,
  ORDER_SOURCE_LABEL,
  NO_SOURCE_LABEL,
  orderSourceTone,
} from "@/lib/order-source";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const UNSET = "__unset__";

/**
 * Sets which channel an order came from, from the list rather than the order
 * form — so the form and its submit path stay untouched, and the orders that
 * predate this can still be tagged.
 *
 * An untagged order is shown in amber rather than as a quiet dash: the report
 * is only as complete as the tagging, and a growing "Not set" pile is the one
 * failure mode of doing this after the fact instead of at order entry.
 */
export function OrderSourceCell({
  slug,
  orderId,
  value,
  canEdit,
}: {
  slug: string;
  orderId: string;
  value: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  if (!canEdit) {
    return (
      <span className={cn(orderSourceTone(value))}>
        {value ? (ORDER_SOURCE_LABEL[value] ?? value) : NO_SOURCE_LABEL}
      </span>
    );
  }

  async function onChange(next: string | null) {
    if (!next) return;
    setSaving(true);
    const res = await setOrderSource(slug, orderId, next === UNSET ? null : next);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    router.refresh();
  }

  return (
    <Select value={value ?? UNSET} onValueChange={onChange} disabled={saving}>
      <SelectTrigger className={cn("h-8 w-36", orderSourceTone(value))}>
        {/* Base UI prints the raw value until the popup has mounted its
            items, so the label is rendered directly. */}
        <span data-slot="select-value">
          {value ? (ORDER_SOURCE_LABEL[value] ?? value) : NO_SOURCE_LABEL}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>{NO_SOURCE_LABEL}</SelectItem>
        {ORDER_SOURCES.map((s) => (
          <SelectItem key={s} value={s}>
            {ORDER_SOURCE_LABEL[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
