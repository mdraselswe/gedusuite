"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateMemberRole, removeMember } from "@/server/actions/team";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Role } from "@prisma/client";

const ROLES: Role[] = ["OWNER", "PARTNER", "MANAGER", "STAFF"];

type Member = {
  id: string;
  role: Role;
  name: string;
  email: string;
};

export function MemberList({
  slug,
  members,
}: {
  slug: string;
  members: Member[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function onRoleChange(membershipId: string, role: string | null) {
    if (!role) return;
    setBusy(membershipId);
    const res = await updateMemberRole(slug, membershipId, role as Role);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Role updated");
    router.refresh();
  }

  async function onRemove(membershipId: string, label: string) {
    if (!confirm(`Remove ${label} from this workspace?`)) return;
    setBusy(membershipId);
    const res = await removeMember(slug, membershipId);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Member removed");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {members.map((m) => (
        <div key={m.id} className="flex items-center justify-between gap-3 text-sm">
          <div className="min-w-0">
            <div className="font-medium">{m.name}</div>
            <div className="truncate text-muted-foreground">{m.email}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select
              value={m.role}
              onValueChange={(v) => onRoleChange(m.id, v)}
              disabled={busy !== null}
            >
              <SelectTrigger className="w-32">
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
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => onRemove(m.id, m.name)}
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
