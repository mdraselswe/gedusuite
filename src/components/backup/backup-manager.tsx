"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { backupNow, previewRestore, applyRestore } from "@/server/actions/backup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { DatabaseBackup } from "lucide-react";

type Setting = {
  lastJsonAt: string | null;
};
type Log = {
  id: string;
  type: string;
  status: string;
  fileUrl: string | null;
  note: string | null;
  createdAt: string;
};

export function BackupManager({
  slug,
  canManage,
  setting,
  logs,
}: {
  slug: string;
  canManage: boolean;
  setting: Setting;
  logs: Log[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  // Restore state
  const [fileText, setFileText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  async function onBackupNow() {
    setBusy("json");
    const res = await backupNow(slug);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    // Trigger a download of the returned JSON.
    const blob = new Blob([res.json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Backup downloaded");
    router.refresh();
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setCounts(null);
    setFileText(null);
    if (!file) return;
    const text = await file.text();
    setFileText(text);
    setFileName(file.name);
    const res = await previewRestore(slug, text);
    if (!res.ok) return toast.error(res.error);
    setCounts(res.counts);
  }

  async function onRestore(mode: "MERGE" | "OVERWRITE") {
    if (!fileText) return;
    const ok = await confirmDialog(
      mode === "OVERWRITE"
        ? {
            title: "Overwrite all data?",
            description:
              "All current business data will be deleted and replaced by the backup. A safety snapshot is taken first.",
            confirmText: "Overwrite",
            destructive: true,
          }
        : {
            title: "Merge backup?",
            description: "Rows from the backup that don't already exist will be added.",
            confirmText: "Merge",
          },
    );
    if (!ok) return;
    setBusy("restore");
    const res = await applyRestore(slug, fileText, mode);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    const total = Object.values(res.inserted).reduce((s, n) => s + n, 0);
    toast.success(`Restore complete — ${total} rows inserted`);
    setFileText(null);
    setCounts(null);
    setFileName("");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Last JSON backup: {setting.lastJsonAt ?? "never"}
        </CardContent>
      </Card>

      {/* Actions */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Backup now</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={onBackupNow} disabled={busy !== null}>
              {busy === "json" ? "Backing up…" : "Download JSON backup"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Restore */}
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Restore from JSON</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input type="file" accept="application/json,.json" onChange={onFile} />
            {counts && (
              <div className="rounded-md bg-muted p-3 text-sm">
                <div className="mb-1 font-medium">Preview — {fileName}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                  {Object.entries(counts).map(([k, v]) => (
                    <span key={k}>
                      {k}: {v}
                    </span>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => onRestore("MERGE")} disabled={busy !== null}>
                    Merge
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => onRestore("OVERWRITE")} disabled={busy !== null}>
                    Overwrite
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Log */}
      <div>
        <h2 className="mb-3 text-lg font-semibold">Backup history</h2>
        <DataTable
          rows={logs}
          rowKey={(l) => l.id}
          empty={{ icon: DatabaseBackup, title: "No backups yet" }}
          columns={
            [
              { key: "when", header: "When", cardTitle: true, cell: (l) => l.createdAt },
              { key: "type", header: "Type", cell: (l) => l.type },
              {
                key: "status",
                header: "Status",
                cell: (l) => (
                  <Badge
                    variant={
                      l.status === "SUCCESS"
                        ? "secondary"
                        : l.status === "FAILED"
                          ? "destructive"
                          : "outline"
                    }
                  >
                    {l.status}
                  </Badge>
                ),
              },
              {
                key: "details",
                header: "Details",
                cell: (l) =>
                  l.fileUrl ? (
                    <a href={l.fileUrl} target="_blank" rel="noreferrer" className="underline">
                      open
                    </a>
                  ) : (
                    <span className="text-muted-foreground">{l.note ?? "—"}</span>
                  ),
              },
            ] as Column<Log>[]
          }
        />
      </div>
    </div>
  );
}
