"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { updatePreferences } from "@/server/actions/preferences";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PRESETS = ["indigo", "green", "rose", "amber"] as const;
const PRESET_COLOR: Record<string, string> = {
  indigo: "oklch(0.51 0.23 277)",
  green: "oklch(0.60 0.17 150)",
  rose: "oklch(0.59 0.22 12)",
  amber: "oklch(0.77 0.16 70)",
};

export function AppearanceForm({
  initial,
}: {
  initial: { theme: string; colorPreset: string; locale: "en" | "bn" };
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const { update } = useSession();
  const [theme, setThemeState] = useState(initial.theme);
  const [preset, setPreset] = useState(initial.colorPreset);
  const [locale, setLocale] = useState<"en" | "bn">(initial.locale);
  const [loading, setLoading] = useState(false);

  function applyPreset(p: string) {
    setPreset(p);
    document.documentElement.dataset.preset = p;
  }
  function applyTheme(t: string) {
    setThemeState(t);
    setTheme(t); // live preview via next-themes
  }

  async function onSave() {
    setLoading(true);
    const fd = new FormData();
    fd.set("theme", theme);
    fd.set("colorPreset", preset);
    fd.set("locale", locale);
    const res = await updatePreferences(fd);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Saved");
    await update(); // refresh JWT locale so server-translated UI updates
    router.refresh(); // re-render server-translated UI (nav) for locale change
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Preferences</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label>Theme</Label>
          <Select value={theme} onValueChange={(v) => applyTheme(v ?? "system")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Color</Label>
          <div className="flex gap-3">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                aria-label={p}
                className={`h-8 w-8 rounded-full border-2 ${
                  preset === p ? "border-foreground" : "border-transparent"
                }`}
                style={{ backgroundColor: PRESET_COLOR[p] }}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Language</Label>
          <Select value={locale} onValueChange={(v) => setLocale((v as "en" | "bn") ?? "en")}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="bn">বাংলা</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button onClick={onSave} disabled={loading}>
          {loading ? "Saving…" : "Save"}
        </Button>
      </CardContent>
    </Card>
  );
}
