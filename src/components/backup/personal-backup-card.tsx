"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { personalSyncNow, disconnectPersonal } from "@/server/actions/personal-backup";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Status = {
  configured: boolean;
  connected: boolean;
  sheetUrl: string | null;
  lastJsonUrl: string | null;
  lastSyncedAt: string | null;
};

export function PersonalBackupCard({ slug, status }: { slug: string; status: Status }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function onSync() {
    setBusy("sync");
    const res = await personalSyncNow(slug);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Synced to your Google Sheet");
    window.open(res.url, "_blank");
    router.refresh();
  }

  async function onDisconnect() {
    const ok = await confirmDialog({
      title: "Disconnect personal backup?",
      description: "Your Google token will be revoked. The Sheet and JSON files stay in your Drive.",
      confirmText: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    setBusy("disconnect");
    const res = await disconnectPersonal(slug);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Disconnected");
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">My personal backup</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Connect <span className="font-medium">your own</span> Google account to keep a
          personal copy of this workspace&apos;s data — a readable Sheet plus a dated JSON
          backup file — in your own Drive. Opt-in and separate from the company backup. Once
          connected, both sync automatically every day — use &quot;Sync to my Sheet&quot; any
          time you want it updated immediately instead of waiting for the next scheduled run.
        </p>

        {!status.configured ? (
          <Badge variant="outline">Google OAuth not configured on the server</Badge>
        ) : !status.connected ? (
          <a
            href={`/api/google/personal/connect?slug=${slug}`}
            className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/80"
          >
            Connect my Google account
          </a>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Connected</Badge>
              <span className="text-muted-foreground">
                Last synced: {status.lastSyncedAt ?? "never"}
              </span>
              {status.sheetUrl && (
                <a href={status.sheetUrl} target="_blank" rel="noreferrer" className="underline">
                  Open my Sheet
                </a>
              )}
              {status.lastJsonUrl && (
                <a href={status.lastJsonUrl} target="_blank" rel="noreferrer" className="underline">
                  Open latest JSON backup
                </a>
              )}
            </div>
            <div className="flex gap-2">
              <Button onClick={onSync} disabled={busy !== null}>
                {busy === "sync" ? "Syncing…" : "Sync to my Sheet"}
              </Button>
              <Button variant="outline" onClick={onDisconnect} disabled={busy !== null}>
                Disconnect
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
