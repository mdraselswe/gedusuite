"use client";

import { useState } from "react";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import { setOrderCampaign } from "@/server/actions/orders";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const UNSET = "__unset__";
const NO_CAMPAIGN_LABEL = "Not set";

export type CampaignOption = { id: string; label: string };

/**
 * Tags an order with the boosting campaign that brought it in.
 *
 * Untagged is left quiet here, unlike the channel cell's amber: a campaign's
 * result still falls back to an estimate from its window and channel, so a
 * blank costs precision rather than losing the order from the report. Only
 * campaigns still worth attributing to are offered — a finished campaign's
 * numbers shouldn't keep moving months later.
 */
export function OrderCampaignCell({
  slug,
  orderId,
  value,
  campaigns,
  canEdit,
}: {
  slug: string;
  orderId: string;
  value: string | null;
  campaigns: CampaignOption[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);

  const current = campaigns.find((c) => c.id === value);
  // A campaign that's no longer offered (paused, finished) but still tagged on
  // this order is shown by name anyway — the tag is the truth, the list is
  // just what's convenient to pick today.
  const label = current?.label ?? (value ? "Tagged campaign" : NO_CAMPAIGN_LABEL);

  if (!canEdit || campaigns.length === 0) {
    return <span className={cn(!value && "text-muted-foreground")}>{label}</span>;
  }

  async function onChange(next: string | null) {
    if (!next) return;
    setSaving(true);
    const res = await setOrderCampaign(slug, orderId, next === UNSET ? null : next);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    router.refresh();
  }

  return (
    <Select value={value ?? UNSET} onValueChange={onChange} disabled={saving}>
      <SelectTrigger className={cn("h-8 w-40", !value && "text-muted-foreground")}>
        {/* Base UI prints the raw value until the popup has mounted its
            items, so the label is rendered directly. */}
        <span data-slot="select-value">{label}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNSET}>{NO_CAMPAIGN_LABEL}</SelectItem>
        {campaigns.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
