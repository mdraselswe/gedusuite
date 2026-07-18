"use client";

import { createContext, useContext, useEffect } from "react";
import { SessionProvider } from "next-auth/react";
import { ThemeProvider, useTheme } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { InstallPrompt } from "@/components/install-prompt";
import { OfflineBanner } from "@/components/offline-banner";
import { translate, type Locale, type MsgKey } from "@/lib/i18n";

type Prefs = { theme: string; preset: string; locale: Locale };

const PreferencesContext = createContext<{ locale: Locale; t: (k: MsgKey) => string }>({
  locale: "en",
  t: (k) => translate("en", k),
});

export function usePreferences() {
  return useContext(PreferencesContext);
}

// Applies the saved color preset + theme once on mount (cross-device sync from DB).
function PrefApplier({ theme, preset }: { theme: string; preset: string }) {
  const { setTheme } = useTheme();
  useEffect(() => {
    document.documentElement.dataset.preset = preset;
  }, [preset]);
  useEffect(() => {
    // Honor the DB theme when the browser has no local override yet.
    if (!localStorage.getItem("theme")) setTheme(theme);
  }, [theme, setTheme]);
  return null;
}

export function Providers({
  children,
  prefs,
}: {
  children: React.ReactNode;
  prefs: Prefs;
}) {
  return (
    <SessionProvider>
      <ThemeProvider attribute="class" defaultTheme={prefs.theme} enableSystem>
        <PreferencesContext.Provider
          value={{ locale: prefs.locale, t: (k) => translate(prefs.locale, k) }}
        >
          <PrefApplier theme={prefs.theme} preset={prefs.preset} />
          {children}
          <InstallPrompt />
          <OfflineBanner />
          <Toaster richColors position="top-center" />
        </PreferencesContext.Provider>
      </ThemeProvider>
    </SessionProvider>
  );
}
