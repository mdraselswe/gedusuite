"use client";

import { use, useState } from "react";
import Link from "next/link";
import { verifyEmailToken } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * A button, not an automatic GET. Mail scanners and link previews open every
 * link in a message; if opening it used the token, a scanner would burn it
 * before the person ever clicked.
 */
export default function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = useState<"idle" | "working" | "ok" | "bad">("idle");

  async function confirm() {
    setState("working");
    setState((await verifyEmailToken(token)) ? "ok" : "bad");
  }

  return (
    <main className="app-canvas flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Confirm your email</CardTitle>
          <CardDescription>One last step to finish setting up your account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state === "ok" ? (
            <>
              <p className="rounded-lg border bg-muted/40 p-3 text-sm">
                Thanks — your email address is confirmed.
              </p>
              <Link href="/" className="text-sm underline underline-offset-4">
                Continue to GeduSuite
              </Link>
            </>
          ) : state === "bad" ? (
            <>
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                This link is invalid or has expired. Sign in and choose &ldquo;Resend confirmation
                email&rdquo; to get a new one.
              </p>
              <Link href="/login" className="text-sm underline underline-offset-4">
                Go to sign in
              </Link>
            </>
          ) : (
            <Button className="w-full" onClick={confirm} disabled={state === "working"}>
              {state === "working" ? "Confirming…" : "Confirm my email"}
            </Button>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
