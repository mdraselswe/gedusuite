"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { acceptInvite } from "@/server/actions/team";
import { Button } from "@/components/ui/button";

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const { update } = useSession();
  const [loading, setLoading] = useState(false);

  async function onAccept() {
    setLoading(true);
    const res = await acceptInvite(token);
    if (!res.ok) {
      setLoading(false);
      toast.error(res.error);
      return;
    }
    await update(); // pull the new membership into the session
    toast.success("Invite accepted");
    router.push(`/${res.slug}/dashboard`);
    router.refresh();
  }

  return (
    <Button className="w-full" onClick={onAccept} disabled={loading}>
      {loading ? "Joining…" : "Accept invitation"}
    </Button>
  );
}
