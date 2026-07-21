"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";

/** Copies the full invite URL for a pending invite — the link is only shown
 * once at creation time, so this lets the owner re-share it later. */
export function CopyInviteButton({ token }: { token: string }) {
  async function onCopy() {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied");
    } catch {
      // Clipboard API can be unavailable (http, older browsers) — show the
      // link so it can be copied manually instead of failing silently.
      window.prompt("Copy the invite link:", url);
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={onCopy}>
      <Copy data-icon="inline-start" />
      Copy link
    </Button>
  );
}
