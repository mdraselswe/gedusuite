"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Truck, Plus, Trash2 } from "lucide-react";
import {
  createCourier,
  updateCourier,
  deleteCourier,
  createSteadfastPreset,
} from "@/server/actions/couriers";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { quoteCourier } from "@/lib/courier";
import { cn } from "@/lib/utils";
import { Money } from "@/components/ui/money";
import { Field } from "@/components/ui/field";

export type CourierZoneRow = { id: string; name: string; rate: number };
export type CourierRow = {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  baseWeightKg: number;
  extraKgRate: number;
  codFeePercent: number;
  codFeeBase: "GROSS" | "NET";
  returnChargeType: "NONE" | "FLAT" | "PERCENT_OF_DELIVERY";
  returnChargeValue: number;
  notes: string | null;
  zones: CourierZoneRow[];
  orderCount: number;
};

type ZoneDraft = { id?: string; name: string; rate: string };

const COD_BASE_LABEL: Record<string, string> = {
  NET: "On what's handed over (COD − delivery charge)",
  GROSS: "On the full COD amount",
};
const RETURN_LABEL: Record<string, string> = {
  NONE: "Nothing",
  FLAT: "A flat amount",
  PERCENT_OF_DELIVERY: "% of the delivery charge",
};

function emptyDraft(): {
  name: string;
  baseWeightKg: string;
  extraKgRate: string;
  codFeePercent: string;
  codFeeBase: "GROSS" | "NET";
  returnChargeType: "NONE" | "FLAT" | "PERCENT_OF_DELIVERY";
  returnChargeValue: string;
  isDefault: boolean;
  isActive: boolean;
  notes: string;
  zones: ZoneDraft[];
} {
  return {
    name: "",
    baseWeightKg: "1",
    extraKgRate: "0",
    codFeePercent: "0",
    codFeeBase: "NET",
    returnChargeType: "NONE",
    returnChargeValue: "0",
    isDefault: false,
    isActive: true,
    notes: "",
    zones: [{ name: "", rate: "" }],
  };
}

export function CourierManager({
  slug,
  couriers,
  canEdit,
}: {
  slug: string;
  couriers: CourierRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [saving, setSaving] = useState(false);

  function openNew() {
    setEditingId(null);
    setDraft(emptyDraft());
    setOpen(true);
  }

  function openEdit(c: CourierRow) {
    setEditingId(c.id);
    setDraft({
      name: c.name,
      baseWeightKg: String(c.baseWeightKg),
      extraKgRate: String(c.extraKgRate),
      codFeePercent: String(c.codFeePercent),
      codFeeBase: c.codFeeBase,
      returnChargeType: c.returnChargeType,
      returnChargeValue: String(c.returnChargeValue),
      isDefault: c.isDefault,
      isActive: c.isActive,
      notes: c.notes ?? "",
      zones: c.zones.map((z) => ({ id: z.id, name: z.name, rate: String(z.rate) })),
    });
    setOpen(true);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const input = {
      ...draft,
      zones: draft.zones
        .filter((z) => z.name.trim())
        .map((z) => ({ id: z.id, name: z.name, rate: z.rate || 0 })),
    };
    const res = editingId
      ? await updateCourier(slug, editingId, input)
      : await createCourier(slug, input);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(editingId ? "Courier updated" : "Courier added");
    setOpen(false);
    router.refresh();
  }

  async function onDelete(c: CourierRow) {
    const ok = await confirmDialog({
      title: `Delete "${c.name}"?`,
      description: "Its zones and rates are removed. Orders already sent with it keep their costs.",
      confirmText: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await deleteCourier(slug, c.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Courier deleted");
    router.refresh();
  }

  async function onPreset() {
    setSaving(true);
    const res = await createSteadfastPreset(slug);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Steadfast added — check the rates match your own contract");
    router.refresh();
  }

  // A worked example on the numbers being typed, because the percentage fee
  // is the part nobody can picture: 1% of a 960 parcel is not 9.60 when the
  // base is NET, and seeing 123.45 while editing is what makes that land.
  const previewZone = draft.zones.find((z) => Number(z.rate) > 0);
  const preview = previewZone
    ? quoteCourier(
        {
          baseWeightKg: Number(draft.baseWeightKg) || 1,
          extraKgRate: Number(draft.extraKgRate) || 0,
          codFeePercent: Number(draft.codFeePercent) || 0,
          codFeeBase: draft.codFeeBase,
          returnChargeType: draft.returnChargeType,
          returnChargeValue: Number(draft.returnChargeValue) || 0,
        },
        { zoneRate: Number(previewZone.rate), weightKg: 0.5, codAmount: 960 },
      )
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Couriers</h2>
        {canEdit && couriers.length === 0 && (
          <Button variant="outline" onClick={onPreset} disabled={saving}>
            Add Steadfast preset
          </Button>
        )}
        {canEdit && <Button onClick={openNew}>New courier</Button>}
      </div>

      {couriers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Truck className="size-6" />
            No couriers yet. Add one and every courier order will price itself —
            delivery charge, weight, and the percentage fee that never gets
            written down.
          </CardContent>
        </Card>
      ) : (
        couriers.map((c) => (
          <Card key={c.id} className={cn(!c.isActive && "opacity-60")}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
              <CardTitle className="text-base">
                {c.name}
                {c.isDefault && (
                  <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    Default
                  </span>
                )}
                {!c.isActive && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">Off</span>
                )}
              </CardTitle>
              {canEdit && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDelete(c)}>
                    Delete
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                {c.zones.map((z) => (
                  <span key={z.id}>
                    {z.name} <span className="font-medium tabular-nums"><Money value={z.rate} /></span>
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                <span>
                  Up to {c.baseWeightKg}kg, then +<Money value={c.extraKgRate} />/kg
                </span>
                <span>
                  COD fee {c.codFeePercent}% —{" "}
                  {c.codFeeBase === "NET" ? "on what's handed over" : "on the full COD"}
                </span>
                <span>Return: {RETURN_LABEL[c.returnChargeType]}
                  {c.returnChargeType !== "NONE" && ` (${c.returnChargeValue})`}
                </span>
                {c.orderCount > 0 && <span>{c.orderCount} order(s) sent</span>}
              </div>
              {c.notes && <p className="text-muted-foreground">{c.notes}</p>}
            </CardContent>
          </Card>
        ))
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit courier" : "New courier"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={onSave} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field name="cr-name" label="Name" required>
                <Input
                  id="cr-name"
                  required
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Steadfast, Pathao, RedX…"
                />
              </Field>
              <Field name="cr-notes" label="Notes (optional)">
                <Input
                  id="cr-notes"
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
              </Field>
            </div>

            <div className="space-y-2">
              <Label>Zones and rates</Label>
              <p className="text-xs text-muted-foreground">
                What they charge to deliver, per area, up to the included weight. Use your
                own negotiated rates — the public price list is usually lower.
              </p>
              {draft.zones.map((z, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={z.name}
                    placeholder="Dhaka City"
                    onChange={(e) => {
                      const zones = [...draft.zones];
                      zones[i] = { ...zones[i], name: e.target.value };
                      setDraft({ ...draft, zones });
                    }}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    className="w-32"
                    value={z.rate}
                    placeholder="65"
                    onChange={(e) => {
                      const zones = [...draft.zones];
                      zones[i] = { ...zones[i], rate: e.target.value };
                      setDraft({ ...draft, zones });
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={draft.zones.length === 1}
                    onClick={() =>
                      setDraft({ ...draft, zones: draft.zones.filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft({ ...draft, zones: [...draft.zones, { name: "", rate: "" }] })}
              >
                <Plus data-icon="inline-start" /> Add zone
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field name="cr-base" label="Weight included (kg)">
                <Input
                  id="cr-base"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={draft.baseWeightKg}
                  onChange={(e) => setDraft({ ...draft, baseWeightKg: e.target.value })}
                />
              </Field>
              <div className="space-y-2">
                <Label htmlFor="cr-extra">Per extra kg</Label>
                <Input
                  id="cr-extra"
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.extraKgRate}
                  onChange={(e) => setDraft({ ...draft, extraKgRate: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">Part of a kilo counts as a whole one.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cr-cod">COD fee %</Label>
                <Input
                  id="cr-cod"
                  type="number"
                  step="0.01"
                  min="0"
                  max="99"
                  value={draft.codFeePercent}
                  onChange={(e) => setDraft({ ...draft, codFeePercent: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Charged on</Label>
                <Select
                  value={draft.codFeeBase}
                  onValueChange={(v) =>
                    setDraft({ ...draft, codFeeBase: (v as "GROSS" | "NET") ?? "NET" })
                  }
                  items={Object.entries(COD_BASE_LABEL).map(([value, label]) => ({ value, label }))}
                >
                  <SelectTrigger className="w-full">
                    <span data-slot="select-value">{COD_BASE_LABEL[draft.codFeeBase]}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(COD_BASE_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The one thing couriers differ on most. Check a real statement if unsure.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Charge on a returned parcel</Label>
                <Select
                  value={draft.returnChargeType}
                  onValueChange={(v) =>
                    setDraft({
                      ...draft,
                      returnChargeType: (v as CourierRow["returnChargeType"]) ?? "NONE",
                    })
                  }
                  items={Object.entries(RETURN_LABEL).map(([value, label]) => ({ value, label }))}
                >
                  <SelectTrigger className="w-full">
                    <span data-slot="select-value">{RETURN_LABEL[draft.returnChargeType]}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(RETURN_LABEL).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {draft.returnChargeType !== "NONE" && (
                <Field name="cr-retval" label={<>{draft.returnChargeType === "FLAT" ? "Amount" : "Percent"}</>}>
                  <Input
                    id="cr-retval"
                    type="number"
                    step="0.01"
                    min="0"
                    value={draft.returnChargeValue}
                    onChange={(e) => setDraft({ ...draft, returnChargeValue: e.target.value })}
                  />
                </Field>
              )}
            </div>

            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
                />
                Offer this one first
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                />
                In use
              </label>
            </div>

            {preview && (
              <p className="rounded-md border bg-muted/40 p-3 text-sm">
                <span className="font-medium">Example</span> — a 0.5kg parcel to{" "}
                {previewZone?.name || "that zone"} collecting ৳960:{" "}
                <span className="font-medium tabular-nums">
                  <Money value={preview.deliveryCharge} /> delivery + <Money value={preview.codFee} /> COD fee
                  = <Money value={preview.total} />
                </span>
              </p>
            )}

            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Add courier"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
