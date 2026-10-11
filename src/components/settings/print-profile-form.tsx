"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { updatePrintProfile } from "@/server/actions/print-profile";
import type { PrintProfile } from "@/lib/print-profile";

/**
 * The shop's own wording and contact channels for gift tags and the leaflet.
 * Anything left blank is not printed (or falls back to plain, generic wording)
 * — see lib/print-profile.
 */
export function PrintProfileForm({
  slug,
  initial,
  websiteUrl,
}: {
  slug: string;
  initial: PrintProfile;
  websiteUrl: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    start(async () => {
      const res = await updatePrintProfile(slug, form);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSaved(true);
      toast.success("Printed extras saved");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Printed extras</CardTitle>
        <CardDescription>
          Used on the gift tags and the leaflet. Your logo, shop name and website come from above
          {websiteUrl ? "" : " (add a website there to get a website QR code)"}. Anything you leave
          blank is simply not printed.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" onChange={() => setSaved(false)}>
          <Field name="facebook" label="Facebook page">
            <Input id="facebook" name="facebook" defaultValue={initial.facebook ?? ""} placeholder="facebook.com/yourpage" />
          </Field>
          <Field name="whatsapp" label="WhatsApp or phone number">
            <Input id="whatsapp" name="whatsapp" defaultValue={initial.whatsapp ?? ""} placeholder="01XXXXXXXXX" inputMode="tel" />
          </Field>
          <Field name="tagline" label="Tagline (leaflet)">
            <Input id="tagline" name="tagline" defaultValue={initial.tagline ?? ""} placeholder="What you sell, in a few words" />
          </Field>
          <Field name="headline" label="Leaflet headline">
            <Textarea id="headline" name="headline" rows={2} defaultValue={initial.headline ?? ""} placeholder="Defaults to your shop name" />
          </Field>
          <div className="sm:col-span-2">
            <Field name="giftLead" label="Gift tag — opening line">
              <Input id="giftLead" name="giftLead" defaultValue={initial.giftLead ?? ""} />
            </Field>
          </div>
          <Field name="giftQuote" label="Gift tag — quote (leave empty to hide)">
            <Input id="giftQuote" name="giftQuote" defaultValue={initial.giftQuote ?? ""} />
          </Field>
          <Field name="giftClosing" label="Gift tag — closing line">
            <Input id="giftClosing" name="giftClosing" defaultValue={initial.giftClosing ?? ""} />
          </Field>
          <div className="sm:col-span-2">
            <Field name="giftThanks" label="Gift tag — thank-you message">
              <Textarea id="giftThanks" name="giftThanks" rows={3} defaultValue={initial.giftThanks ?? ""} />
            </Field>
          </div>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save printed extras"}
            </Button>
            {saved ? <span className="text-sm text-muted-foreground">Saved</span> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
