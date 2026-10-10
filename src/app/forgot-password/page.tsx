"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { requestPasswordReset } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const res = await requestPasswordReset(new FormData(e.currentTarget));
    setLoading(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setSent(true);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Forgot your password?</CardTitle>
          <CardDescription>
            Enter your email and we will send you a link to choose a new one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sent ? (
            <p className="rounded-lg border bg-muted/40 p-3 text-sm">
              If an account exists for that address, a reset link is on its way. It works once and
              expires in 30 minutes.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <Field name="email" label="Email" required>
                <Input id="email" name="email" type="email" required autoComplete="email" />
              </Field>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}
          <p className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="underline underline-offset-4">
              Back to sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
