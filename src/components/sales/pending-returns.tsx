"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PackageX, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { OVERDUE_RETURN_DAYS } from "@/lib/returns";
import {
  markReturnReceived,
  receiveReturnedGoods,
  writeOffReturnedGoods,
} from "@/server/actions/orders";

/**
 * Goods the shop is owed and hasn't got: cancelled parcels the courier is
 * carrying back, and customer returns still in the post.
 *
 * The list exists because the stock derivation now holds those pieces off the
 * shelf until somebody says they arrived — and a hold with nothing to release
 * it is worse than no hold at all. It is also the first time this shop can see
 * what a courier is sitting on: before, a parcel that was never brought back
 * simply stayed on the shelf as stock that had not been there for months.
 *
 * Hidden entirely when there is nothing waiting. A permanent empty card on the
 * busiest page in the app is a permanent small tax on reading it.
 */

/** One line of a parcel, as it left. `kind` matches the server's line ids. */
export type PendingLine = {
  kind: "ITEM" | "GIFT";
  id: string;
  label: string;
  quantity: number;
};

export type PendingParcel = {
  orderId: string;
  label: string;
  customerName: string;
  courierName: string | null;
  trackingId: string | null;
  /** Whole days since the cancellation — how overdue this parcel is. */
  waitingDays: number;
  lines: PendingLine[];
};

export type PendingCustomerReturn = {
  returnId: string;
  /** The product that is coming back. */
  label: string;
  orderLabel: string;
  quantity: number;
  waitingDays: number;
};


export function PendingReturns({
  slug,
  parcels,
  returns,
  canEdit,
}: {
  slug: string;
  parcels: PendingParcel[];
  returns: PendingCustomerReturn[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [receiving, setReceiving] = useState<PendingParcel | null>(null);
  const [good, setGood] = useState<Record<string, string>>({});
  const [shortfall, setShortfall] = useState<"DAMAGED" | "LOST">("DAMAGED");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (parcels.length === 0 && returns.length === 0) return null;

  /**
   * How many of a line won't be going back on the shelf.
   *
   * A cleared box counts as nothing having come back, because that is what
   * submitting it does — it previewed as "nothing written off" and then wrote
   * the whole line off.
   */
  const shortOf = (l: PendingLine) => {
    const typed = parseInt(good[`${l.kind}:${l.id}`] ?? "", 10);
    return Math.max(0, l.quantity - (Number.isFinite(typed) ? typed : 0));
  };
  const shortTotal = receiving?.lines.reduce((s, l) => s + shortOf(l), 0) ?? 0;

  function openReceive(p: PendingParcel) {
    // Everything came back whole until somebody says otherwise: that is the
    // ordinary case, and a dialog that starts at zero makes the ordinary case
    // the one with the most typing.
    setGood(Object.fromEntries(p.lines.map((l) => [`${l.kind}:${l.id}`, String(l.quantity)])));
    setShortfall("DAMAGED");
    setNote("");
    setReceiving(p);
  }

  async function onReceive() {
    if (!receiving) return;
    setSaving(true);
    const res = await receiveReturnedGoods(slug, receiving.orderId, {
      lines: receiving.lines.map((l) => ({
        kind: l.kind,
        id: l.id,
        good: good[`${l.kind}:${l.id}`] ?? "0",
      })),
      shortfall,
      note,
    });
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Goods booked back in");
    setReceiving(null);
    router.refresh();
  }

  async function onWriteOff(p: PendingParcel) {
    const ok = await confirmDialog({
      title: "Write this parcel off?",
      description:
        `${p.lines.reduce((s, l) => s + l.quantity, 0)} pcs from ${p.customerName}'s order will be ` +
        "recorded as lost, at what they cost. Do this only once the courier has said it isn't coming.",
      confirmText: "It never came back",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(p.orderId);
    const res = await writeOffReturnedGoods(slug, p.orderId);
    setBusyId(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Written off as lost");
    router.refresh();
  }

  async function onReturnReceived(r: PendingCustomerReturn) {
    setBusyId(r.returnId);
    const res = await markReturnReceived(slug, r.returnId);
    setBusyId(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Back on the shelf");
    router.refresh();
  }

  const waiting = parcels.length + returns.length;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Undo2 className="size-4" />
            Coming back — {waiting} waiting
          </CardTitle>
          <CardDescription>
            These pieces are out of stock until they arrive, so nobody sells what the
            courier is still holding. Mark them received the day the box is opened.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {parcels.map((p) => (
            <div
              key={p.orderId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium">{p.customerName}</div>
                <div className="text-xs text-muted-foreground">
                  {p.label}
                  {p.courierName ? ` · ${p.courierName}` : ""}
                  {p.trackingId ? ` · ${p.trackingId}` : ""}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {p.lines.map((l) => `${l.label} ×${l.quantity}`).join(", ")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    p.waitingDays >= OVERDUE_RETURN_DAYS
                      ? "text-xs font-semibold text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {p.waitingDays === 0 ? "today" : `${p.waitingDays}d waiting`}
                </span>
                {canEdit && (
                  <>
                    <Button size="sm" onClick={() => openReceive(p)}>
                      Received
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === p.orderId}
                      onClick={() => onWriteOff(p)}
                    >
                      <PackageX className="size-4" />
                      Never came
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}

          {returns.map((r) => (
            <div
              key={r.returnId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium">
                  {r.label} ×{r.quantity}
                </div>
                <div className="text-xs text-muted-foreground">
                  Customer return · {r.orderLabel}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={
                    r.waitingDays >= OVERDUE_RETURN_DAYS
                      ? "text-xs font-semibold text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {r.waitingDays === 0 ? "today" : `${r.waitingDays}d waiting`}
                </span>
                {canEdit && (
                  <Button
                    size="sm"
                    disabled={busyId === r.returnId}
                    onClick={() => onReturnReceived(r)}
                  >
                    Received
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* The receive step. A parcel comes back soaked as often as it comes back
          whole, and this is the one moment anybody looks inside it — so what
          didn't survive gets written off here rather than being noticed weeks
          later as stock that isn't on the shelf. */}
      <Dialog open={!!receiving} onOpenChange={(o) => !o && setReceiving(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Book the parcel back in</DialogTitle>
          </DialogHeader>
          {receiving && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                How many of each came back fit to sell? Anything short of what went out
                is written off, so the shelf matches the box.
              </p>
              <div className="space-y-2">
                {receiving.lines.map((l) => {
                  const key = `${l.kind}:${l.id}`;
                  const short = shortOf(l);
                  return (
                    <div key={key} className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {l.label}
                          {l.kind === "GIFT" && (
                            <span className="text-muted-foreground"> (gift)</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {l.quantity} went out
                          {short > 0 ? ` · ${short} written off` : ""}
                        </div>
                      </div>
                      <Input
                        type="number"
                        min="0"
                        max={l.quantity}
                        className="w-24"
                        value={good[key] ?? ""}
                        onChange={(e) =>
                          setGood((g) => ({ ...g, [key]: e.target.value }))
                        }
                      />
                    </div>
                  );
                })}
              </div>

              {/* Only once something is actually short. On a parcel that came
                  back whole this question has no answer, and asking it anyway
                  made the ordinary case look like it needed a decision — a
                  dropdown sitting there pre-set to "Came back damaged" on a
                  parcel where nothing was. */}
              {shortTotal > 0 && (
                <div className="space-y-2">
                  <Label>
                    What happened to the {shortTotal} pc{shortTotal === 1 ? "" : "s"} not
                    coming back?
                  </Label>
                  <Select
                    value={shortfall}
                    onValueChange={(v) => setShortfall((v as "DAMAGED" | "LOST") ?? "DAMAGED")}
                    items={[
                      { value: "DAMAGED", label: "Came back damaged" },
                      { value: "LOST", label: "Missing from the parcel" },
                    ]}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DAMAGED">Came back damaged</SelectItem>
                      <SelectItem value="LOST">Missing from the parcel</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Becomes a stock adjustment with this order named on it, so the two
                    can be told apart later — a courier that damages parcels and one
                    that loses pieces are different complaints.
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="pr-note">Note</Label>
                <Input
                  id="pr-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional — box was open, two packets soaked…"
                />
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setReceiving(null)}
                  disabled={saving}
                >
                  Not yet
                </Button>
                <Button type="button" onClick={onReceive} disabled={saving}>
                  {saving ? "Saving…" : "Book it in"}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
