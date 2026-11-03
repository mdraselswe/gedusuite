"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FormError, type FieldError } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { saveResellerSettings } from "@/server/actions/reseller";
import { tierLabel, type ResellerTier } from "@/lib/reseller-pricing";
import type { ResellerListSettings } from "@/lib/reseller-list";

type TierDraft = { minQty: string; discountPct: string };

export function ResellerSettingsForm({
  slug,
  settings,
  canEdit,
}: {
  slug: string;
  settings: ResellerListSettings;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<FieldError>(null);
  const [title, setTitle] = useState(settings.title);
  const [notes, setNotes] = useState(settings.notes);
  const [minMarginPct, setMinMarginPct] = useState(String(settings.minMarginPct));
  const [roundTo, setRoundTo] = useState(String(settings.roundTo));
  const [tiers, setTiers] = useState<TierDraft[]>(
    settings.tiers.map((t) => ({ minQty: String(t.minQty), discountPct: String(t.discountPct) })),
  );

  // Labels follow what's typed, so "5–9 pcs" updates as the next band moves.
  const preview: ResellerTier[] = tiers
    .map((t) => ({ minQty: Number(t.minQty), discountPct: Number(t.discountPct) }))
    .filter((t) => t.minQty >= 1);
  const sortedPreview = [...preview].sort((a, b) => a.minQty - b.minQty);

  function setTier(i: number, patch: Partial<TierDraft>) {
    setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await saveResellerSettings(slug, { title, notes, minMarginPct, roundTo, tiers });
      if (!res.ok) {
        setError(res);
        toast.error(res.error);
        return;
      }
      toast.success("Reseller pricing saved");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pricing rules</CardTitle>
        <CardDescription>
          Each band takes a discount off the retail price. A calculated price never goes under cost plus
          the minimum margin. You can set any product&apos;s price by hand in the table below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <fieldset disabled={!canEdit || pending} className="space-y-4">
            <Field name="title" label="List name" error={error}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </Field>

            <div className="space-y-2">
              <div className="text-sm font-medium">Quantity bands</div>
              <div className="space-y-2">
                {tiers.map((t, i) => {
                  const idx = sortedPreview.findIndex((p) => p.minQty === Number(t.minQty));
                  return (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground">From</span>
                      <Input
                        type="number"
                        min={1}
                        className="w-20"
                        aria-label="From quantity"
                        value={t.minQty}
                        disabled={i === 0}
                        onChange={(e) => setTier(i, { minQty: e.target.value })}
                      />
                      <span className="text-sm text-muted-foreground">pcs, discount</span>
                      <Input
                        type="number"
                        min={0}
                        max={90}
                        step="0.5"
                        className="w-20"
                        aria-label="Discount percent"
                        value={t.discountPct}
                        onChange={(e) => setTier(i, { discountPct: e.target.value })}
                      />
                      <span className="text-sm text-muted-foreground">%</span>
                      <span className="min-w-16 text-xs text-muted-foreground">
                        {idx >= 0 ? tierLabel(sortedPreview, idx) : ""}
                      </span>
                      {i > 0 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove band"
                          onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {tiers.length < 8 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const last = Math.max(...tiers.map((t) => Number(t.minQty) || 1));
                    const lastPct = Number(tiers[tiers.length - 1]?.discountPct) || 0;
                    setTiers((ts) => [...ts, { minQty: String(last * 2), discountPct: String(lastPct + 5) }]);
                  }}
                >
                  <Plus className="size-4" /> Add band
                </Button>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="minMarginPct"
                label="Minimum margin over cost (%)"
                hint="A calculated price is raised to at least cost + this."
                error={error}
              >
                <Input type="number" min={0} step="0.5" value={minMarginPct} onChange={(e) => setMinMarginPct(e.target.value)} />
              </Field>
              <Field name="roundTo" label="Round prices up to" hint="e.g. 5 → ৳853 becomes ৳855" error={error}>
                <Input type="number" min={1} value={roundTo} onChange={(e) => setRoundTo(e.target.value)} />
              </Field>
            </div>

            <Field
              name="notes"
              label="Terms for resellers"
              hint="Shown on the sheet's Terms tab and under the PDF: minimum resale price, delivery, payment, returns."
              error={error}
            >
              <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </fieldset>
          <FormError error={error} />
          {canEdit ? (
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save rules"}
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
