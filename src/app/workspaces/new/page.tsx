"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { createWorkspace } from "@/server/actions/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field } from "@/components/ui/field";

export default function NewWorkspacePage() {
  const router = useRouter();
  const { update } = useSession();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const res = await createWorkspace(new FormData(e.currentTarget));
    if (!res.ok) {
      setLoading(false);
      toast.error(res.error);
      return;
    }
    // Refresh the JWT so the new membership shows up in the session.
    await update();
    toast.success("Workspace created");
    router.push(`/${res.slug}/dashboard`);
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Create a workspace</CardTitle>
          <CardDescription>
            A workspace is one business. You’ll be its owner.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <Field name="name" label="Business name" required>
              <Input id="name" name="name" required placeholder="e.g. GeduShop" />
            </Field>
            <Field name="themeColor" label="Theme color (optional)">
              <Input id="themeColor" name="themeColor" placeholder="#4f46e5" />
            </Field>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Creating…" : "Create workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
