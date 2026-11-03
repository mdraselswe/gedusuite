"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoNote } from "@/components/ui/info-note";
import {
  addResellerViewer,
  disconnectResellerGoogle,
  removeResellerViewer,
  setResellerPublic,
  syncResellerNow,
} from "@/server/actions/reseller";

export type ResellerGoogleState = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  sheetUrl: string | null;
  viewers: string[];
  publicLink: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
};

export function ResellerGoogleCard({
  slug,
  canEdit,
  state,
  notice,
}: {
  slug: string;
  canEdit: boolean;
  state: ResellerGoogleState;
  /** Back from Google: "connected", or the reason it failed. */
  notice: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!notice) return;
    if (notice === "connected") toast.success("Google account connected");
    else toast.error(notice);
    router.replace(`/${slug}/products/reseller`);
  }, [notice, router, slug]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) {
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error ?? "Something went wrong");
        return;
      }
      if (done) toast.success(done);
      router.refresh();
    });
  }

  const connectHref = `/api/google/personal/connect?slug=${encodeURIComponent(slug)}&purpose=reseller`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google Sheet for resellers</CardTitle>
        <CardDescription>
          Resellers get view-only access. The sheet updates by itself whenever a product, a purchase or
          these rules change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!state.configured ? (
          <p className="text-sm text-muted-foreground">Google sign-in is not set up on this server.</p>
        ) : !state.connected ? (
          <div className="space-y-2">
            <p className="text-sm">
              Connect the Google account the sheet should belong to — for example the shop&apos;s own
              Gmail. Sign in to that account when Google asks.
            </p>
            {canEdit ? (
              <a href={connectHref} className={buttonVariants({ size: "sm" })}>
                Connect Google account
              </a>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div>
                Account: <span className="font-medium">{state.email ?? "connected"}</span>
              </div>
              {canEdit ? (
                <div className="flex gap-2">
                  <a href={connectHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                    Change
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={pending}
                    onClick={() => {
                      if (!confirm("Disconnect? The sheet stays in that Google Drive but stops updating.")) return;
                      run(() => disconnectResellerGoogle(slug), "Disconnected");
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {state.sheetUrl ? (
                <a href={state.sheetUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open sheet <ExternalLink className="size-3.5" />
                </a>
              ) : null}
              {canEdit ? (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const res = await syncResellerNow(slug);
                      if (res.ok && res.queued) toast.message("A sync is already running — it will include this.");
                      return res;
                    }, state.sheetUrl ? "Sheet updated" : "Sheet created")
                  }
                >
                  {pending ? "Working…" : state.sheetUrl ? "Sync now" : "Create Google Sheet"}
                </Button>
              ) : null}
            </div>
            <div className="text-xs text-muted-foreground">
              {state.lastSyncedAt ? `Last updated ${state.lastSyncedAt}` : "Not synced yet"}
            </div>
            {state.lastSyncError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
                Last sync failed: {state.lastSyncError}
              </p>
            ) : null}

            <div className="space-y-2">
              <div className="text-sm font-medium">Resellers who can view</div>
              {state.viewers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody yet.</p>
              ) : (
                <ul className="space-y-1">
                  {state.viewers.map((v) => (
                    <li key={v} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm">
                      <span className="truncate">{v}</span>
                      {canEdit ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${v}`}
                          disabled={pending}
                          onClick={() => {
                            if (!confirm(`Stop sharing the sheet with ${v}?`)) return;
                            run(() => removeResellerViewer(slug, v), "Access removed");
                          }}
                        >
                          <X className="size-4" />
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit ? (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () => {
                      const res = await addResellerViewer(slug, email);
                      if (res.ok) setEmail("");
                      return res;
                    }, state.sheetUrl ? "Shared — Google emails them the link" : "Added — they get access when the sheet is created");
                  }}
                >
                  <Input
                    type="email"
                    placeholder="reseller@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                  <Button type="submit" variant="outline" disabled={pending}>
                    Add
                  </Button>
                </form>
              ) : null}
            </div>

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={state.publicLink}
                disabled={!canEdit || pending}
                onCheckedChange={(v) => {
                  const on = !!v;
                  if (on && !confirm("Anyone with the link will be able to view the price list. Continue?")) return;
                  run(() => setResellerPublic(slug, on), on ? "Anyone with the link can view" : "Only invited resellers can view");
                }}
              />
              <span>
                Anyone with the link can view
                <span className="block text-xs text-muted-foreground">
                  Off: only the emails above. Viewers can never edit, and can&apos;t download, print or copy.
                </span>
              </span>
            </label>

            <InfoNote title="Adding product pictures to the sheet">
              <p>
                Column A (&quot;Image&quot;) is yours: click a cell there in the sheet and use Insert → Image →
                Insert image in cell, or type <code>=IMAGE(&quot;https://…/photo.jpg&quot;)</code>. Syncing never
                touches that column, and a picture stays with its product when rows are re-sorted.
              </p>
            </InfoNote>
          </>
        )}
      </CardContent>
    </Card>
  );
}
