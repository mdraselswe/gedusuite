"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { deleteWorkspace } from "@/server/actions/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DangerZone({ slug, workspaceName }: { slug: string; workspaceName: string }) {
  const router = useRouter();
  const { update } = useSession();
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function onDelete(e: React.FormEvent) {
    e.preventDefault();
    setDeleting(true);
    const res = await deleteWorkspace(slug, confirmName);
    setDeleting(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Workspace deleted");
    await update(); // refresh JWT memberships so the deleted workspace disappears
    router.push("/");
    router.refresh();
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Permanently delete this workspace and all of its data — products, orders, customers,
          treasury, everything. This cannot be undone.
        </p>
        <Button
          variant="destructive"
          onClick={() => {
            setConfirmName("");
            setOpen(true);
          }}
        >
          Delete workspace
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{workspaceName}”?</DialogTitle>
            <DialogDescription>
              All data in this workspace will be permanently deleted for every member. Download a
              JSON backup first if you might need it later.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={onDelete} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dz-confirm">
                Type <span className="font-semibold">{workspaceName}</span> to confirm
              </Label>
              <Input
                id="dz-confirm"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={workspaceName}
                autoComplete="off"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={deleting || confirmName.trim() !== workspaceName}
              >
                {deleting ? "Deleting…" : "Delete forever"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
