"use client";

import { useEffect, useState } from "react";
import { useRouter } from "@/lib/live-router";
import { toast } from "sonner";
import { AlertTriangle, Loader2, PackageCheck } from "lucide-react";
import {
  bookParcel,
  parcelPreview,
  type ParcelPreview,
} from "@/server/actions/courier-booking";
import { mentionsDistrict } from "@/lib/bd-locations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Money } from "@/components/ui/money";

/** Below this it is not an address, it is a half-typed box. Matches the server. */
const MIN_ADDRESS = 15;

/**
 * The last thing between an order and a real parcel.
 *
 * The address is a single editable box because that is exactly what the API
 * takes: `recipient_address` is one line of free text, with no district or
 * city field beside it, so whatever is in this box is the whole of what the
 * courier's sorters will read. Showing it as anything else — a fixed line with
 * pickers bolted on — would be dressing up a text field as a form and hiding
 * the one thing worth checking.
 *
 * The only hard stop is an address too short to be one. Everything else is a
 * warning: an address can be perfectly good and still name no district this
 * app recognises, because it was written in Bangla or in shorthand, and a
 * refusal there would be the app overruling somebody who can see the order and
 * knows the customer.
 */
export function ParcelBookingDialog({
  slug,
  orderId,
  open,
  onOpenChange,
}: {
  slug: string;
  orderId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [preview, setPreview] = useState<ParcelPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setLoadError(null);
    parcelPreview(slug, orderId).then((res) => {
      if (cancelled) return;
      if (!res.ok) return setLoadError(res.error);
      setPreview(res.preview);
      setAddress(res.preview.address);
      setNote(res.preview.note);
    });
    return () => {
      cancelled = true;
    };
  }, [open, slug, orderId]);

  const blocked = (preview?.blockers.length ?? 0) > 0;
  const tooShort = address.trim().length < MIN_ADDRESS;
  const noDistrict = !tooShort && !mentionsDistrict(address);
  const edited = !!preview && address.trim() !== preview.address.trim();
  const canSend = !!preview && !blocked && !tooShort && !sending;

  async function send() {
    if (!canSend) return;
    setSending(true);
    const res = await bookParcel(slug, orderId, { address, note });
    setSending(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Booked — consignment ${res.consignmentId}`);
    // The parcel went; the status move is what failed. Held on screen for ten
    // seconds because it means the order is still sitting in its old status
    // and somebody has to decide what to do about it.
    if (res.warning) toast.warning(res.warning, { duration: 10000 });
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send to {preview?.courierName ?? "courier"}</DialogTitle>
        </DialogHeader>

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        {!preview && !loadError && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading the order…
          </div>
        )}

        {preview && (
          <div className="space-y-4">
            {preview.blockers.length > 0 && (
              <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <ul className="space-y-1">
                  {preview.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Invoice</dt>
              <dd className="font-medium">{preview.invoice}</dd>

              <dt className="text-muted-foreground">Name</dt>
              <dd>{preview.recipientName || <Missing />}</dd>

              <dt className="text-muted-foreground">Phone</dt>
              <dd>
                {preview.recipientPhone ?? (
                  <span className="text-destructive">{preview.rawPhone || "—"}</span>
                )}
              </dd>

              <dt className="text-muted-foreground">Collect (COD)</dt>
              <dd className="font-medium">
                <Money value={preview.codAmount} />
                {preview.codAmount === 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    already paid — nothing to collect
                  </span>
                )}
              </dd>

              <dt className="text-muted-foreground">Items</dt>
              <dd className="text-muted-foreground">{preview.itemDescription || "—"}</dd>
            </dl>

            <div className="space-y-1.5">
              <Label htmlFor="parcel-address">
                Delivery address <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="parcel-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                rows={3}
                maxLength={500}
                disabled={blocked}
                className={noDistrict ? "border-amber-500 dark:border-amber-600" : undefined}
              />
              <p className="text-xs text-muted-foreground">
                This exact text is what the courier gets — it has no separate district or city
                field.
              </p>

              {tooShort && (
                <p className="text-xs text-destructive">
                  Too short to deliver to — at least {MIN_ADDRESS} characters.
                </p>
              )}
              {noDistrict && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  No district name found in this address. Fine if it is written in Bangla or
                  shorthand — worth a second look otherwise.
                </p>
              )}
              {edited && !tooShort && (
                <p className="text-xs text-muted-foreground">
                  Edited — this will be saved onto the order too, so the invoice matches the
                  parcel.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="parcel-note">Note for the rider (optional)</Label>
              <Input
                id="parcel-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Call before delivery…"
                disabled={blocked}
                maxLength={300}
              />
              {preview.note && (
                <p className="text-xs text-muted-foreground">
                  Filled in from the order&apos;s note — the courier prints this, so clear
                  anything meant only for the shop.
                </p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} disabled={!canSend}>
            {sending ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Booking…
              </>
            ) : (
              <>
                <PackageCheck className="size-4" /> Book parcel
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Missing() {
  return <span className="text-destructive">missing</span>;
}
