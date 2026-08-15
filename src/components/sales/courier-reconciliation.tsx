"use client";

import { useState } from "react";
import Link from "next/link";
import { Truck } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@/lib/live-router";
import { recordCollectedAmount } from "@/server/actions/orders";
import { importCourierPayouts } from "@/server/actions/cash-custody";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/ui/data-table";
import { cn } from "@/lib/utils";
import { formatMoney as money } from "@/lib/money";
import { Stamp } from "@/components/ui/stamp";
import type { DhakaStamp } from "@/lib/dhaka-time";

type Parcel = DhakaStamp & {
  id: string;
  customerName: string;
  trackingId: string | null;
  status: string;
  /** What the courier last said about the parcel, from its webhook. */
  courierStatus: string | null;
  /** What the courier's ledger has — the invoice, less any shortfall. */
  cod: number;
  invoiced: number;
  shortfall: number;
  shortfallNote: string | null;
  deliveryCost: number;
  codFee: number;
  net: number;
};

export type CourierAccount = {
  id: string;
  name: string;
  /** The courier can be asked what it has actually paid out. */
  apiConnected: boolean;
  /** What its own app says it is holding, last time we asked. */
  liveBalance: number | null;
  /** Delivered, money collected, not yet handed over. */
  holding: Parcel[];
  /** Sent but not delivered — nothing collected yet. */
  inTransit: Parcel[];
  expected: number;
  inTransitValue: number;
};


/**
 * Expected balance against the courier's own figure.
 *
 * The comparison is typed in rather than fetched: couriers don't all have an
 * API, and the number is on screen in their app anyway. What matters is that
 * the difference is computed for you — reading two numbers and subtracting
 * them by hand is exactly the step that gets skipped.
 */
export function CourierReconciliation({
  slug,
  accounts,
  canEdit,
}: {
  slug: string;
  accounts: CourierAccount[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [actual, setActual] = useState<Record<string, string>>({});
  // The parcel whose collected figure is being corrected, if any.
  const [adjusting, setAdjusting] = useState<Parcel | null>(null);
  const [collected, setCollected] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  async function onImport(a: CourierAccount) {
    setImporting(a.id);
    const res = await importCourierPayouts(slug, a.id);
    setImporting(null);
    if (!res.ok) return toast.error(res.error);
    if (res.imported === 0) {
      toast.success("Nothing new — every payout is already recorded");
    } else {
      for (const p of res.payouts) {
        toast.success(
          `${p.externalId}: ৳${p.total} for ${p.parcels} parcel(s)` +
            (Math.abs(p.difference) >= 0.01 ? `, ৳${p.difference} difference recorded` : ""),
          { duration: 10000 },
        );
      }
    }
    // Named rather than swallowed: a parcel the courier paid for that this app
    // has never heard of is the one thing an import cannot reconcile by itself.
    if (res.unmatched.length > 0) {
      toast.warning(
        `${res.unmatched.length} parcel(s) in those payouts aren't in this app: ${res.unmatched.join(", ")}`,
        { duration: 15000 },
      );
    }
    router.refresh();
  }

  function openAdjust(p: Parcel) {
    setAdjusting(p);
    // Prefilled with what the courier is currently believed to have collected,
    // so correcting a wrong correction is a retype of one field.
    setCollected(String(p.cod));
    setNote(p.shortfallNote ?? "");
  }

  async function saveAdjust(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!adjusting) return;
    setSaving(true);
    const res = await recordCollectedAmount(slug, adjusting.id, Number(collected), note);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Saved — the balance, the treasury and this order's profit all follow it");
    setAdjusting(null);
    router.refresh();
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <Truck className="size-6" />
          Nothing with a courier right now.{" "}
          <Link href={`/${slug}/settings/couriers`} className="underline underline-offset-2">
            Set up your couriers
          </Link>{" "}
          so every order prices itself.
        </CardContent>
      </Card>
    );
  }

  const columns: Column<Parcel>[] = [
    {
      key: "date",
      header: "Date",
      cell: (p) => <Stamp date={p.date} time={p.time} entered={p.entered} />,
      sortValue: (p) => p.date,
    },
    {
      key: "customer",
      header: "Customer",
      cardTitle: true,
      wrap: true,
      cell: (p) => (
        <span>
          <span className="inline-flex items-center gap-1.5">
            {p.customerName}
            {/* A cancelled parcel sitting in a list of delivered ones needs
                saying out loud, and the two kinds are opposite facts: one
                collected some money, the other collected none and cost you the
                trip. Calling both "Partial" put a row worth minus 115 under a
                word that means "some of it came in". */}
            {p.status === "CANCELLED" &&
              (p.cod > 0 ? (
                <Badge
                  variant="outline"
                  className="border-orange-500/40 bg-orange-500/15 font-normal text-orange-800 dark:bg-orange-500/25 dark:text-orange-200"
                  title="Cancelled — only what the customer handed over is with the courier"
                >
                  Partial
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-red-500/40 bg-red-500/15 font-normal text-red-800 dark:bg-red-500/25 dark:text-red-200"
                  title="Came back undelivered — nothing collected, and the courier still charged for the trip"
                >
                  Returned
                </Badge>
              ))}
          </span>
          {/* The courier saying it settled this parcel for less than the
              invoice. It never says how much less — that figure is only in its
              own app — so this points at the row and leaves the number to a
              person. Hidden once somebody has answered it. */}
          {p.courierStatus === "partial_delivered" && p.shortfall === 0 && (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/15 font-normal text-amber-800 dark:bg-amber-500/25 dark:text-amber-200"
              title="The courier settled this parcel for less than the full amount — check what it actually collected"
            >
              Check amount
            </Badge>
          )}
          {p.trackingId && (
            <span className="block text-xs text-muted-foreground">{p.trackingId}</span>
          )}
        </span>
      ),
    },
    {
      key: "cod",
      header: "COD",
      align: "right",
      sortValue: (p) => p.cod,
      // Click-to-correct, the way the courier ID cell on the sales list works.
      // This is the screen where a wrong collection is noticed — the balance
      // disagrees with the courier's app — so it is the screen that should be
      // able to answer it.
      cell: (p) => {
        const figure = (
          <span
            className={cn(p.status === "CANCELLED" && "text-orange-800 dark:text-orange-200")}
            title={p.status === "CANCELLED" ? "Collected on a partial delivery" : undefined}
          >
            {money(p.cod)}
          </span>
        );
        const short = p.shortfall > 0 && (
          <span
            className="block text-xs text-destructive"
            title={p.shortfallNote ?? "Never reached the courier's ledger"}
          >
            {money(p.shortfall)} short of {money(p.invoiced)}
          </span>
        );
        // Cancelled parcels keep their own collected figure, entered with the
        // cancellation — one fact, one place to change it.
        if (!canEdit || p.status === "CANCELLED") {
          return (
            <span className="block">
              {figure}
              {short}
            </span>
          );
        }
        return (
          <button
            type="button"
            onClick={() => openAdjust(p)}
            className="block w-full text-right underline-offset-4 hover:underline"
            title="The courier collected a different amount"
          >
            {figure}
            {short}
          </button>
        );
      },
    },
    {
      key: "charge",
      header: "Delivery",
      align: "right",
      hideable: true,
      cell: (p) => money(p.deliveryCost),
    },
    {
      key: "codFee",
      header: "COD fee",
      align: "right",
      hideable: true,
      // A zero here on a courier that charges a percentage means the order was
      // entered before its rates were set up — worth spotting, not hiding.
      cell: (p) => (
        <span className={cn(p.codFee === 0 && "text-muted-foreground")}>{money(p.codFee)}</span>
      ),
    },
    {
      key: "net",
      header: "You get",
      align: "right",
      sortValue: (p) => p.net,
      // A returned parcel is money going the other way. Printed in the
      // destructive colour so a minus sign isn't the only thing separating it
      // from a row that earned you eight hundred taka.
      cell: (p) => (
        <span className={cn("font-medium tabular-nums", p.net < 0 && "text-destructive")}>
          {money(p.net)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {accounts.map((a) => {
        const typed = actual[a.id];
        // What the courier's own app says, fetched rather than typed where the
        // API can be asked. Typing over it still wins — a figure read off the
        // screen a minute ago is a legitimate thing to check against.
        const actualNum =
          typed === undefined || typed === "" ? a.liveBalance : Number(typed);
        const diff = actualNum === null ? null : Math.round((actualNum - a.expected) * 100) / 100;
        // Three different things live in `holding`, and the line under the
        // total has to add up to what's in the table below it.
        const delivered = a.holding.filter((p) => p.status !== "CANCELLED").length;
        const partial = a.holding.filter((p) => p.status === "CANCELLED" && p.cod > 0).length;
        const returned = a.holding.filter((p) => p.status === "CANCELLED" && p.cod <= 0).length;

        return (
          <Card key={a.id}>
            <CardHeader className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">{a.name}</CardTitle>
                {canEdit && a.apiConnected && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onImport(a)}
                    disabled={importing !== null}
                  >
                    {/* Named for what it does to the books rather than for the
                        mechanism. "Import payouts" describes the API call; the
                        person pressing it has just seen money arrive and wants
                        the treasury to say so. */}
                    {importing === a.id ? "Fetching…" : "Get what they paid"}
                  </Button>
                )}
                <Link
                  href={`/${slug}/sales/orders`}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  open orders
                </Link>
              </div>
              {/* When to press it, and what it saves you from. Without this the
                  only visible way to bank a courier's cash was to tick the
                  orders off by hand on the treasury page, which banks the app's
                  own per-parcel figures and leaves the payout's rounding
                  unaccounted for. */}
              {canEdit && a.apiConnected && (
                <p className="text-xs text-muted-foreground">
                  Press <b>Get what they paid</b> once {a.name}&apos;s money is in your
                  account. It reads what they actually paid, banks those parcels, and
                  records any difference — so the treasury matches your bank to the taka.
                  Nothing to undo if you press it early: it just says there is nothing new.
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-muted-foreground">
                    They should be holding
                  </div>
                  <div className="text-2xl font-bold tabular-nums">{money(a.expected)}</div>
                  <div className="text-xs text-muted-foreground">
                    {delivered} delivered parcel(s)
                    {partial > 0 && ` + ${partial} partial`}
                    {returned > 0 && ` − ${returned} returned`}, COD less their charges
                  </div>
                  {/* The rule this page runs on, said once where it matters:
                      "paid" happens when the rider takes the cash, which is
                      the moment the courier starts holding it. */}
                  <div className="mt-1 text-xs text-muted-foreground">
                    Counts every delivered parcel until its cash is marked deposited —
                    do that when the courier actually pays out. A returned parcel
                    subtracts what the courier charged to bring it back.
                  </div>
                  {/* Which of the app's two figures to trust against the
                      courier's own app. The percentage fee is charged once on
                      the payout and rounded down, so it cannot be split across
                      parcels exactly; this page applies it the courier's way and
                      the treasury applies it per parcel, because profit is a
                      per-order question. On a set this size they land a taka or
                      two apart, and reading the treasury card against the
                      courier's app is what makes that look like an error. */}
                  <div className="mt-1 text-xs text-muted-foreground">
                    This is the figure to compare with their app. The treasury&apos;s
                    &ldquo;cash with courier&rdquo; card works the percentage fee out per
                    parcel rather than once on the payout, so it reads a taka or two
                    apart from this — importing the payout settles the difference.
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`actual-${a.id}`} className="text-xs text-muted-foreground">
                    Balance in their app
                  </Label>
                  <Input
                    id={`actual-${a.id}`}
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    placeholder={
                      a.liveBalance !== null ? String(a.liveBalance) : "Type it to compare"
                    }
                    value={typed ?? ""}
                    onChange={(e) => setActual({ ...actual, [a.id]: e.target.value })}
                  />
                  {a.liveBalance !== null && (
                    <p className="text-xs text-muted-foreground">
                      {money(a.liveBalance)} in their app just now
                    </p>
                  )}
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Difference</div>
                  {diff === null ? (
                    <div className="text-2xl font-bold text-muted-foreground">—</div>
                  ) : (
                    <>
                      <div
                        className={cn(
                          "text-2xl font-bold tabular-nums",
                          Math.abs(diff) < 1
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-destructive",
                        )}
                      >
                        {diff > 0 ? "+" : ""}
                        {money(diff)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {/* Named in the order they actually turn up. Every
                            figure below is derived from the invoice except one
                            — what somebody typed as collected on a parcel that
                            came up short, or on a partial delivery — so that is
                            where a gap of a few taka almost always sits. This
                            hint used to guess at a mispriced parcel, which is
                            the rarer of the two and sends the reader to the
                            rate table instead of to the row. */}
                        {Math.abs(diff) < 1
                          ? "Matches — nothing unexplained."
                          : diff < 0
                            ? "They hold less than expected: a charge you don't have — a rate that isn't what's set up, or a returned parcel whose charge nobody typed in."
                            : "They hold more than expected: they collected more on a parcel than was recorded here — check any row where a shortfall or a partial delivery was typed in — or a delivery cost is set higher here than they charged."}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {a.inTransit.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Plus {a.inTransit.length} parcel(s) still on the way, worth{" "}
                  <span className="font-medium tabular-nums">{money(a.inTransitValue)}</span> —
                  not in the balance above, because nothing has been collected yet.
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <DataTable
                rows={a.holding}
                rowKey={(p) => p.id}
                empty={{ title: "Nothing delivered and unpaid" }}
                columns={columns}
              />
              {a.inTransit.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">Still on the way</div>
                  <DataTable
                    rows={a.inTransit}
                    rowKey={(p) => p.id}
                    empty={{ title: "Nothing in transit" }}
                    columns={columns.filter((c) => c.key !== "net")}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Correcting what the courier actually collected. Asks for the figure
          from its app rather than for the difference: that is the number on
          the screen the person is looking at, and a subtraction typed by hand
          is a subtraction that can be got wrong. */}
      <Dialog open={!!adjusting} onOpenChange={(o) => !o && setAdjusting(null)}>
        <DialogContent>
          <form onSubmit={saveAdjust}>
            <DialogHeader>
              <DialogTitle>What did the courier collect?</DialogTitle>
            </DialogHeader>
            {adjusting && (
              <div className="grid gap-3 py-4">
                <p className="text-sm text-muted-foreground">
                  {adjusting.customerName} · invoiced{" "}
                  <span className="font-medium text-foreground">{money(adjusting.invoiced)}</span>
                </p>
                <div className="grid gap-1.5">
                  <Label htmlFor="collected">Collected, as the courier&apos;s app shows it</Label>
                  <Input
                    id="collected"
                    type="number"
                    step="0.01"
                    min="0"
                    max={adjusting.invoiced}
                    inputMode="decimal"
                    autoFocus
                    value={collected}
                    onChange={(e) => setCollected(e.target.value)}
                  />
                  {Number(collected) < adjusting.invoiced && (
                    <p className="text-xs text-muted-foreground">
                      {money(adjusting.invoiced - Number(collected || 0))} of what the customer
                      paid never reached the business. It comes off this order&apos;s profit and
                      out of what the courier owes you — and it is not a debt of the
                      customer&apos;s, because they paid in full.
                    </p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="collectedNote">What happened</Label>
                  <Input
                    id="collectedNote"
                    maxLength={200}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. rider took 60 as a tip, COD entered wrong"
                  />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
