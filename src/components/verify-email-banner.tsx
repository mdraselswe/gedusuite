"use client";

import { useState } from "react";
import { toast } from "sonner";
import { resendVerificationEmail } from "@/server/actions/auth";

/**
 * Shown to a signed-in person whose address has not been confirmed yet. It
 * never blocks the app — only the few actions that need a verified identity
 * (creating a workspace) do — so it is a prompt, not a wall.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function resend() {
    setBusy(true);
    const res = await resendVerificationEmail();
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setSent(true);
    toast.success("Confirmation email sent");
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200"
    >
      <span>
        Please confirm your email address (<strong>{email}</strong>). We sent you a link.
      </span>
      <button
        type="button"
        onClick={resend}
        disabled={busy || sent}
        className="underline underline-offset-4 disabled:opacity-60"
      >
        {sent ? "Sent" : busy ? "Sending…" : "Resend confirmation email"}
      </button>
    </div>
  );
}
