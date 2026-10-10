"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { sendSupportMessage } from "@/server/actions/support";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export function SupportForm({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    start(async () => {
      const res = await sendSupportMessage(slug, form);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSent(true);
    });
  }

  if (sent) {
    return (
      <p className="rounded-lg border bg-muted/40 p-4 text-sm">
        Message sent. We will reply to the email address on your account.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field name="subject" label="What is it about?" required>
        <Input id="subject" name="subject" required maxLength={120} />
      </Field>
      <Field name="message" label="Details" required>
        <Textarea id="message" name="message" rows={6} required maxLength={4000} />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send message"}
      </Button>
    </form>
  );
}
