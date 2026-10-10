"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  disconnectWebsite,
  rotateWebsiteSecrets,
  saveWebsiteIntegration,
  testWebsiteConnection,
  type WebsiteIntegrationState,
} from "@/server/actions/integrations";

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex gap-2">
        <Input readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success("Copied");
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}

export function WebsiteConnection({
  slug,
  state,
}: {
  slug: string;
  state: WebsiteIntegrationState;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [testing, setTesting] = useState(false);

  function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    start(async () => {
      const res = await saveWebsiteIntegration(slug, form);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success("Website connection saved");
      router.refresh();
    });
  }

  async function test() {
    setTesting(true);
    const res = await testWebsiteConnection(slug);
    setTesting(false);
    if (res.ok) toast.success("Connected — the website answered");
    else toast.error(res.error);
  }

  return (
    <div className="space-y-6">
      {state.source === "environment" ? (
        <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm">
          This workspace is currently using the connection configured on the server. Saving details
          below switches it to its own connection.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>WooCommerce store</CardTitle>
          <CardDescription>
            In WooCommerce go to Settings → Advanced → REST API and create a key with Read/Write
            permission. The keys are stored encrypted and are never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field name="url" label="Website address" required>
                <Input
                  id="url"
                  name="url"
                  placeholder="https://shop.example.com"
                  defaultValue={state.url ?? ""}
                  required
                />
              </Field>
            </div>
            <Field name="consumerKey" label={`API key${state.consumerKeyHint ? ` (saved ${state.consumerKeyHint})` : ""}`}>
              <Input id="consumerKey" name="consumerKey" placeholder="ck_…" autoComplete="off" />
            </Field>
            <Field name="consumerSecret" label="API secret">
              <Input id="consumerSecret" name="consumerSecret" placeholder="cs_…" type="password" autoComplete="off" />
            </Field>
            <Field name="writeKey" label={`Write key — optional${state.writeKeyHint ? ` (saved ${state.writeKeyHint})` : ""}`}>
              <Input id="writeKey" name="writeKey" placeholder="Only if different from above" autoComplete="off" />
            </Field>
            <Field name="writeSecret" label="Write secret — optional">
              <Input id="writeSecret" name="writeSecret" type="password" autoComplete="off" />
            </Field>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save connection"}
              </Button>
              <Button type="button" variant="outline" onClick={test} disabled={testing || state.source === "none"}>
                {testing ? "Testing…" : "Test connection"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {state.orderWebhookUrl ? (
        <Card>
          <CardHeader>
            <CardTitle>Order webhook</CardTitle>
            <CardDescription>
              In WooCommerce → Settings → Advanced → Webhooks add two webhooks (order created, order
              updated) using these values. New website orders then appear in your call list.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <CopyRow label="Delivery URL" value={state.orderWebhookUrl} />
            {state.webhookSecret ? <CopyRow label="Secret" value={state.webhookSecret} /> : null}
            {state.cartBeaconUrl ? (
              <>
                <hr />
                <p className="text-xs text-muted-foreground">
                  Abandoned-cart beacon — only if your storefront sends one.
                </p>
                <CopyRow label="Beacon URL" value={state.cartBeaconUrl} />
                {state.cartBeaconSecret ? <CopyRow label="Beacon secret" value={state.cartBeaconSecret} /> : null}
              </>
            ) : null}
            <div className="pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!confirm("Generate a new address and secrets? The current webhooks stop working until you update them in WooCommerce.")) return;
                  start(async () => {
                    const res = await rotateWebsiteSecrets(slug);
                    if (!res.ok) toast.error(res.error);
                    else {
                      toast.success("New webhook details generated");
                      router.refresh();
                    }
                  });
                }}
              >
                Regenerate webhook details
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {state.source === "workspace" ? (
        <Button
          type="button"
          variant="ghost"
          className="text-destructive"
          onClick={() => {
            if (!confirm("Disconnect this website? Orders already imported are kept.")) return;
            start(async () => {
              const res = await disconnectWebsite(slug);
              if (!res.ok) toast.error(res.error);
              else {
                toast.success("Website disconnected");
                router.refresh();
              }
            });
          }}
        >
          Disconnect website
        </Button>
      ) : null}
    </div>
  );
}
