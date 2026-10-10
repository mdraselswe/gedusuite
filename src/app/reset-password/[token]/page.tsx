"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { resetPassword } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [failedMsg, setFailedMsg] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      toast.error("The two passwords do not match");
      return;
    }
    form.set("token", token);
    setLoading(true);
    const res = await resetPassword(form);
    setLoading(false);
    if (!res.ok) {
      setFailedMsg(res.error);
      return;
    }
    toast.success("Password changed. Please sign in.");
    router.push("/login");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Choose a new password</CardTitle>
          <CardDescription>At least 8 characters.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {failedMsg ? (
            <div className="space-y-3">
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                {failedMsg}
              </p>
              <Link href="/forgot-password" className="text-sm underline underline-offset-4">
                Request a new link
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              <Field name="password" label="New password" required>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </Field>
              <Field name="confirm" label="Confirm new password" required>
                <Input
                  id="confirm"
                  name="confirm"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                />
              </Field>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Saving…" : "Change password"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
