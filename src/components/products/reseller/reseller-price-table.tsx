"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Money } from "@/components/ui/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { saveVariantResellerPrice } from "@/server/actions/reseller";
import {
  MAX_BANDS,
  priceVariant,
  tierLabel,
  tiersForBands,
  type PricingSettings,
  type TierPrice,
} from "@/lib/reseller-pricing";
import type { InternalRow } from "@/lib/reseller-list";
import { cn } from "@/lib/utils";

// Pinned cells need a solid background, or the columns scrolling under them show through.
const HEAD = "sticky top-0 z-20 bg-card shadow-[0_1px_0_var(--border)]";
const PIN_LEFT = "sticky left-0 shadow-[1px_0_0_var(--border)]";
const PIN_RIGHT = "sticky right-0 shadow-[-1px_0_0_var(--border)]";
// Same colour the row turns on hover (muted at half strength over the card).
const CELL_BG = "bg-card group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--card))]";

function rowName(r: InternalRow) {
  return r.variant ? `${r.product} (${r.variant})` : r.product;
}

export function ResellerPriceTable({
  slug,
  canEdit,
  rows,
  pricing,
}: {
  slug: string;
  canEdit: boolean;
  rows: InternalRow[];
  pricing: PricingSettings;
}) {
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(true);
  const [editing, setEditing] = useState<InternalRow | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (showHidden || !r.hidden) &&
        (!q || `${r.product} ${r.variant} ${r.sku ?? ""} ${r.category ?? ""}`.toLowerCase().includes(q)),
    );
  }, [rows, search, showHidden]);

  const counts = {
    listed: rows.filter((r) => !r.hidden && r.priced).length,
    hidden: rows.filter((r) => r.hidden).length,
    unpriced: rows.filter((r) => !r.priced).length,
    warn: rows.filter((r) => r.priced && (r.priced.bandsOutOfOrder || r.priced.tiers.some((t) => t.belowFloor))).length,
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>All products — your view</CardTitle>
        <CardDescription>
          Cost, profit and margin are only shown here. The reseller sheet and PDF show only the
          reseller prices and the retail price. {counts.listed} on the list
          {counts.hidden ? `, ${counts.hidden} hidden` : ""}
          {counts.unpriced ? `, ${counts.unpriced} without a retail price (not listed)` : ""}
          {counts.warn ? `, ${counts.warn} need a look` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search product, SKU, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showHidden} onCheckedChange={(v) => setShowHidden(!!v)} />
            Show hidden
          </label>
        </div>

        {/*
          The table scrolls inside its own box, sized to the screen, so the
          sideways scrollbar is always in view rather than under the last row.
          Header, product and edit button stay put while it scrolls.
        */}
        <div className="rounded-lg border">
          <Table containerClassName="max-h-[min(75vh,calc(100dvh_-_14rem))] overflow-auto">
            <TableHeader>
              <TableRow>
                <TableHead className={cn(HEAD, PIN_LEFT, "z-30 min-w-56")}>Product</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Cost</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Retail</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Floor</TableHead>
                <TableHead className={HEAD}>Reseller price by quantity</TableHead>
                {canEdit ? <TableHead className={cn(HEAD, PIN_RIGHT, "z-30 w-12")} /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No products match.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((r) => (
                  // Fade the contents, not the row: a faded sticky cell would
                  // show the columns scrolling behind it.
                  <TableRow key={r.variantId} className={cn("group", r.hidden && "[&>td>*]:opacity-50")}>
                    <TableCell className={cn(PIN_LEFT, CELL_BG, "z-10 w-64 max-w-72 align-top whitespace-normal")}>
                      <div className="line-clamp-2 font-medium" title={r.product}>
                        {r.product}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {r.variant ? <span>{r.variant}</span> : null}
                        {r.sku ? <span className="font-mono">{r.sku}</span> : null}
                        {r.category ? <span>· {r.category}</span> : null}
                        {r.hidden ? <Badge variant="outline">Hidden</Badge> : null}
                        {r.customBands ? <Badge variant="secondary">Own bands</Badge> : null}
                        {!r.priced ? <Badge variant="destructive">No retail price</Badge> : null}
                        {r.priced?.bandsOutOfOrder ? (
                          <Badge variant="destructive">Bigger band costs more</Badge>
                        ) : null}
                        {r.priced && r.priced.cost == null ? <Badge variant="outline">No cost recorded</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right align-top">
                      {r.priced?.cost != null ? <Money value={r.priced.cost} /> : "—"}
                    </TableCell>
                    <TableCell className="text-right align-top">{r.priced ? <Money value={r.priced.retail} /> : "—"}</TableCell>
                    <TableCell className="text-right align-top text-muted-foreground">
                      {r.priced?.floor != null ? <Money value={r.priced.floor} /> : "—"}
                    </TableCell>
                    <TableCell className="align-top">
                      {r.priced ? (
                        <div className="grid w-max grid-cols-[auto_auto_auto_auto] items-baseline gap-x-4 gap-y-1">
                          {r.priced.tiers.map((t) => (
                            <BandLine key={t.minQty} t={t} />
                          ))}
                        </div>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    {canEdit ? (
                      <TableCell className={cn(PIN_RIGHT, CELL_BG, "z-10 align-top")}>
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${rowName(r)}`} onClick={() => setEditing(r)}>
                          <Pencil className="size-4" />
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {editing ? (
        <EditDialog key={editing.variantId} slug={slug} row={editing} pricing={pricing} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
}

/** One band in the table: its price, what the shop makes, what the reseller keeps. */
function BandLine({ t }: { t: TierPrice }) {
  return (
    <>
      <span className="text-xs whitespace-nowrap text-muted-foreground">{t.label}</span>
      <span className={cn("text-right font-semibold whitespace-nowrap", t.belowFloor && "text-destructive")}>
        <Money value={t.price} />
        {t.manual ? <span className="ml-1 text-[10px] font-normal text-sky-600">manual</span> : null}
        {t.raisedToFloor ? <span className="ml-1 text-[10px] font-normal text-amber-600">floor</span> : null}
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        {t.profit != null ? (
          <>
            profit <Money value={t.profit} tone={t.profit < 0 ? "negative" : "neutral"} />
            {t.marginPct != null ? ` · ${t.marginPct}%` : ""}
          </>
        ) : (
          "profit —"
        )}
      </span>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        reseller keeps <Money value={t.resellerGain} />
      </span>
    </>
  );
}

type BandDraft = { minQty: string; price: string };

function EditDialog({
  slug,
  row,
  pricing,
  onClose,
}: {
  slug: string;
  row: InternalRow;
  pricing: PricingSettings;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(row.hidden);
  const [own, setOwn] = useState(row.customBands != null);
  const [drafts, setDrafts] = useState<BandDraft[]>(() =>
    (row.customBands ?? pricing.tiers.map((t) => t.minQty)).map((q) => ({
      minQty: String(q),
      price: row.overrides[q] != null ? String(row.overrides[q]) : "",
    })),
  );

  // The bands as they stand in the dialog, and what each would cost untouched.
  const qtys = drafts.map((d) => Math.floor(Number(d.minQty)));
  const valid = qtys.every((q) => Number.isFinite(q) && q >= 1) && new Set(qtys).size === qtys.length;
  const tiers = useMemo(
    () => (valid ? tiersForBands(pricing.tiers, [...qtys].sort((a, b) => a - b)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [valid, qtys.join(","), pricing.tiers],
  );
  const auto = useMemo(() => {
    if (!tiers || !row.priced) return new Map<number, number>();
    const p = priceVariant({ cost: row.priced.cost, retail: row.priced.retail }, { ...pricing, tiers });
    return new Map(p.tiers.map((t) => [t.minQty, t.price]));
  }, [tiers, row.priced, pricing]);
  const label = (q: number) => {
    const i = tiers?.findIndex((t) => t.minQty === q) ?? -1;
    return tiers && i >= 0 ? tierLabel(tiers, i) : "—";
  };

  function setDraft(i: number, patch: Partial<BandDraft>) {
    setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  function toggleOwn(on: boolean) {
    setOwn(on);
    // Back to the list's bands: keep any price typed for a band it also has.
    if (!on) {
      setDrafts((ds) =>
        pricing.tiers.map((t) => ({
          minQty: String(t.minQty),
          price: ds.find((d) => Number(d.minQty) === t.minQty)?.price ?? "",
        })),
      );
    }
  }

  function addBand() {
    const next = Math.max(1, ...qtys.filter(Number.isFinite)) + 1;
    setDrafts((ds) => [...ds, { minQty: String(next), price: "" }]);
  }

  function save(next: { hidden: boolean; prices: Record<string, number | null>; bands: number[] | null }) {
    start(async () => {
      const res = await saveVariantResellerPrice(slug, row.variantId, next);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Saved — the sheet updates in a moment");
      onClose();
      router.refresh();
    });
  }

  function submit() {
    if (!valid) {
      toast.error("Each band needs its own starting quantity, 1 or more");
      return;
    }
    save({
      hidden,
      bands: own ? qtys : null,
      prices: Object.fromEntries(drafts.map((d) => [String(Math.floor(Number(d.minQty))), d.price.trim() === "" ? null : Number(d.price)])),
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rowName(row)}</DialogTitle>
          <DialogDescription>
            Leave a price empty to use the calculated one. A hand-set price is used exactly as typed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={hidden} onCheckedChange={(v) => setHidden(!!v)} />
            Hide from resellers (not on the sheet or PDF)
          </label>
          {row.priced ? (
            <>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={own} onCheckedChange={(v) => toggleOwn(!!v)} />
                <span>
                  Own quantity bands for this product
                  <span className="block text-xs text-muted-foreground">
                    Off: the bands from Pricing rules. On: set where each band starts, e.g. 1, 2 and 6 for
                    &quot;1 pc / 2–5 pcs / 6+ pcs&quot;.
                  </span>
                </span>
              </label>
              <div className="space-y-2">
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="w-20">From qty</span>
                  <span className="w-20">Band</span>
                  <span className="w-28">Price</span>
                </div>
                {drafts.map((d, i) => {
                  const q = qtys[i];
                  const typed = d.price.trim() === "" ? null : Number(d.price);
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <Input
                        type="number"
                        min={1}
                        step="1"
                        className="w-20"
                        aria-label="Band starts at quantity"
                        value={d.minQty}
                        disabled={!own || i === 0}
                        onChange={(e) => setDraft(i, { minQty: e.target.value })}
                      />
                      <span className="w-20 text-sm">{label(q)}</span>
                      <Input
                        type="number"
                        min={0}
                        step="1"
                        className="w-28"
                        aria-label={`Price for ${label(q)}`}
                        placeholder={auto.has(q) ? String(auto.get(q)) : ""}
                        value={d.price}
                        onChange={(e) => setDraft(i, { price: e.target.value })}
                      />
                      <span className="flex-1 text-xs text-muted-foreground">
                        {row.priced!.cost != null && typed != null
                          ? `profit ৳${Math.round((typed - row.priced!.cost) * 100) / 100}`
                          : ""}
                      </span>
                      {own && i > 0 ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove band"
                          onClick={() => setDrafts((ds) => ds.filter((_, j) => j !== i))}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
                {own && drafts.length < MAX_BANDS ? (
                  <Button variant="outline" size="sm" onClick={addBand}>
                    <Plus className="size-4" /> Add band
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              This product has no retail price, so it can&apos;t go on the list. Set a sale price on the product first.
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={pending} onClick={() => save({ hidden: false, prices: {}, bands: null })}>
            Reset to calculated
          </Button>
          <Button disabled={pending} onClick={submit}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
