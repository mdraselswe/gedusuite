"use client";

import { useState } from "react";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import { setLeadChannel } from "@/server/actions/leads";
import { ORDER_SOURCES, ORDER_SOURCE_LABEL, NO_SOURCE_LABEL } from "@/lib/order-source";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const UNSET = "__unset__";

/**
 * Which channel a lead came through, set from the list — the same shape and
 * wording as an order's source cell, because they are the same question asked
 * at two moments and answering them differently would make the two lists
 * impossible to compare.
 *
 * Untagged shows amber rather than a quiet dash: a growing "Not set" pile is
 * the one way this fails, and it should be visible while it is still small.
 */
export function LeadChannelCell({
  slug,
  leadId,
  value,
  canEdit,
}: {
  slug: string;
  leadId: string;
  value: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const label = value ? (ORDER_SOURCE_LABEL[value] ?? value) : NO_SOURCE_LABEL;

  if (!canEdit) {
    return (
      <span className={cn("text-sm", !value && "text-amber-700 dark:text-amber-400")}>
        {label}
      </span>
    );
  }

  async function onChange(next: string | null) {
    if (!next) return;
    setSaving(true);
    const res = await setLeadChannel(slug, leadId, next === UNSET ? null : next);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    router.refresh();
  }

  return (
    <Select value={value ?? UNSET} onValueChange={onChange} disabled={saving}>
      <SelectTrigger
        className={cn(
          "h-8 w-32",
          !value && "border-amber-500/50 text-amber-700 dark:text-amber-400",
        )}
      >
        {/* Base UI prints the raw value until the popup has mounted its
            items, so the label is rendered directly. */}
        <span data-slot="select-value">{label}</span>
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
