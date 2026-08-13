"use client";

import { useState } from "react";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import { Truck, Plus, Plug, Trash2 } from "lucide-react";
import {
  createCourier,
  updateCourier,
  deleteCourier,
  createSteadfastPreset,
  connectCourierApi,
  disconnectCourierApi,
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

export type CourierZoneRow = {
  id: string;
  name: string;
  rate: number;
  bands: { uptoKg: number; rate: number }[];
};
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
  /** Whether parcels can be booked through this courier, and what its webhook needs. */
  api: {
    connected: boolean;
    keyHint: string | null;
    webhookUrl: string | null;
    webhookSecret: string | null;
  };
  zones: CourierZoneRow[];
  orderCount: number;
};

type BandDraft = { uptoKg: string; rate: string };
type ZoneDraft = { id?: string; name: string; rate: string; bands: BandDraft[] };

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
    zones: [{ name: "", rate: "", bands: [] }],
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
      zones: c.zones.map((z) => ({
        id: z.id,
        name: z.name,
        rate: String(z.rate),
        bands: z.bands.map((b) => ({ uptoKg: String(b.uptoKg), rate: String(b.rate) })),
      })),
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
        .map((z) => ({
          id: z.id,
          name: z.name,
          rate: z.rate || 0,
          // A half-typed band is dropped rather than saved as a zero-weight
          // step that would swallow every parcel.
          bands: z.bands
            .filter((b) => Number(b.uptoKg) > 0 && b.rate !== "")
            .map((b) => ({ uptoKg: Number(b.uptoKg), rate: Number(b.rate) })),
        })),
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
        {
          zoneRate: Number(previewZone.rate),
          bands: previewZone.bands
            .filter((b) => Number(b.uptoKg) > 0 && b.rate !== "")
            .map((b) => ({ uptoKg: Number(b.uptoKg), rate: Number(b.rate) })),
          weightKg: 0.5,
          codAmount: 960,
        },
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
                    {z.name}{" "}
                    {z.bands.length > 0 ? (
                      <span className="font-medium tabular-nums">
                        {z.bands
                          .slice()
                          .sort((a, b) => a.uptoKg - b.uptoKg)
                          .map((b) => `${b.uptoKg}kg ৳${b.rate}`)
                          .join(" · ")}
                      </span>
                    ) : (
                      <span className="font-medium tabular-nums"><Money value={z.rate} /></span>
                    )}
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
              {canEdit && <CourierApiPanel slug={slug} courier={c} />}
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
              {draft.zones.map((z, i) => {
                const setZone = (patch: Partial<ZoneDraft>) => {
                  const zones = [...draft.zones];
                  zones[i] = { ...zones[i], ...patch };
                  setDraft({ ...draft, zones });
                };
                return (
                <div key={i} className="space-y-2 rounded-md border p-2">
                <div className="flex items-center gap-2">
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

                {/* Weight steps. Couriers here price by slab — 55 for a light
                    Dhaka parcel, 65 for a full one — which the rate above and
                    the per-kilo surcharge below cannot express between them:
                    that pair only ever adds money above an included weight,
                    never takes it off under one. A zone with no steps keeps
                    using the flat rate, so this stays invisible until it is
                    needed. */}
                {z.bands.length > 0 && (
                  <div className="space-y-1.5 pl-1">
                    {z.bands.map((b, bi) => (
                      <div key={bi} className="flex items-center gap-2">
                        <span className="shrink-0 text-xs text-muted-foreground">up to</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0.01"
                          className="w-24"
                          placeholder="0.25"
                          value={b.uptoKg}
                          onChange={(e) => {
                            const bands = [...z.bands];
                            bands[bi] = { ...bands[bi], uptoKg: e.target.value };
                            setZone({ bands });
                          }}
                        />
                        <span className="shrink-0 text-xs text-muted-foreground">kg costs</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          className="w-24"
                          placeholder="55"
                          value={b.rate}
                          onChange={(e) => {
                            const bands = [...z.bands];
                            bands[bi] = { ...bands[bi], rate: e.target.value };
                            setZone({ bands });
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setZone({ bands: z.bands.filter((_, j) => j !== bi) })}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      A parcel takes the first step it fits in. Heavier than every step, or
                      never weighed, and it pays the last one — plus the per-kilo charge
                      below, measured from that step&apos;s limit.
                    </p>
                  </div>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setZone({ bands: [...z.bands, { uptoKg: "", rate: "" }] })}
                >
                  <Plus data-icon="inline-start" /> Add a weight step
                </Button>
                </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setDraft({ ...draft, zones: [...draft.zones, { name: "", rate: "", bands: [] }] })
                }
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

/**
 * One value to carry across to the courier's portal, with the button that
 * carries it. Both fields on that form are long random strings that nobody
 * retypes correctly, so copying is the only realistic way in.
 */
function CopyRow({
  label,
  value,
  secret,
}: {
  label: string;
  value: string;
  /** Masked until asked for — it authenticates every status write. */
  secret?: boolean;
}) {
  const [shown, setShown] = useState(!secret);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
          {shown ? value : "•".repeat(32)}
        </code>
        {secret && (
          <Button size="sm" variant="ghost" onClick={() => setShown((s) => !s)}>
            {shown ? "Hide" : "Show"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            navigator.clipboard.writeText(value);
            toast.success(`${label} copied`);
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

/**
 * Connecting a courier's API, so orders can be booked from the orders page
 * instead of retyped into the courier's own app.
 *
 * The key is verified against the courier before it is stored — pasting a
 * wrong one should fail here, in a settings page with nobody waiting, rather
 * than later in front of a packed parcel. Once stored it is encrypted and
 * never sent back to the browser; all this panel can ever show is the last
 * four characters, which is enough to tell two keys apart.
 */
function CourierApiPanel({ slug, courier }: { slug: string; courier: CourierRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [saving, setSaving] = useState(false);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await connectCourierApi(slug, courier.id, { apiKey, secretKey });
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Connected — the key works");
    setApiKey("");
    setSecretKey("");
    setOpen(false);
    router.refresh();
  }

  async function disconnect() {
    const ok = await confirmDialog({
      title: `Disconnect ${courier.name}?`,
      description:
        "Parcels go back to being booked by hand in the courier's app. Nothing already booked is affected.",
      confirmText: "Disconnect",
    });
    if (!ok) return;
    const res = await disconnectCourierApi(slug, courier.id);
    if (!res.ok) return toast.error(res.error);
    toast.success("Disconnected");
    router.refresh();
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Plug className="size-4" />
          {courier.api.connected ? (
            <>
              Booking enabled
              <span className="font-normal text-muted-foreground">
                key {courier.api.keyHint}
              </span>
            </>
          ) : (
            <span className="font-normal text-muted-foreground">
              Not connected — parcels are booked by hand
            </span>
          )}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {courier.api.connected ? "Replace key" : "Connect API"}
          </Button>
          {courier.api.connected && (
            <Button size="sm" variant="ghost" onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {courier.api.connected && courier.api.webhookUrl && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            In the courier app under <strong>Update Webhook</strong>, so delivery statuses come
            back on their own. The field names there match these two:
          </p>
          <CopyRow label="Callback URL" value={courier.api.webhookUrl} />
          {courier.api.webhookSecret && (
            <CopyRow label="Auth token (bearer)" value={courier.api.webhookSecret} secret />
          )}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {courier.name}</DialogTitle>
          </DialogHeader>
          <form onSubmit={connect} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              In the courier&apos;s app: API Integration → Generate Key. Both values are stored
              encrypted and never shown again.
            </p>
            <Field name="api-key" label="API key" required>
              <Input
                id="api-key"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <Field name="secret-key" label="Secret key" required>
              <Input
                id="secret-key"
                required
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Checking the key…" : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
