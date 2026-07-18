"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { inviteMember } from "@/server/actions/team";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ROLES = ["PARTNER", "MANAGER", "STAFF", "OWNER"] as const;

export function InviteForm({ slug }: { slug: string }) {
  const router = useRouter();
  const [role, setRole] = useState<string>("STAFF");
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const form = new FormData(e.currentTarget);
    form.set("slug", slug);
    form.set("role", role);
    const res = await inviteMember(form);
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const fullUrl = `${window.location.origin}${res.inviteUrl}`;
    setLink(fullUrl);
    void navigator.clipboard?.writeText(fullUrl).catch(() => {});
    toast.success("Invite created — link copied to clipboard");
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite a member</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" required placeholder="person@example.com" />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v ?? "STAFF")}>
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? "Inviting…" : "Send invite"}
          </Button>
        </form>
        {link && (
          <p className="break-all rounded-md bg-muted p-3 text-xs">
            No email service yet — share this link: <span className="font-mono">{link}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
