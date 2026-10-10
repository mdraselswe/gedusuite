"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { toast } from "sonner";
import { deleteMyAccount } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function DeleteAccountCard({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  async function confirmDelete() {
    setBusy(true);
    const form = new FormData();
    form.set("confirmEmail", typed);
    const res = await deleteMyAccount(form);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Your account was deleted");
    await signOut({ callbackUrl: "/login" });
  }

  return (
    <Card className="border-destructive/30">
      <CardHeader>
        <CardTitle>Delete my account</CardTitle>
        <CardDescription>
          Removes your sign-in and your membership of every workspace. The businesses themselves
          are not touched. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!open ? (
          <Button variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
            Delete my account…
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              Type <strong>{email}</strong> to confirm.
            </p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                disabled={busy || typed.trim().toLowerCase() !== email.toLowerCase()}
                onClick={confirmDelete}
              >
                {busy ? "Deleting…" : "Permanently delete"}
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
