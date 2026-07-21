"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

// Minimal typing for the non-standard beforeinstallprompt event.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

// The `hidden` state alone only lasts for the current page — the browser
// re-fires beforeinstallprompt on later navigations/reloads, and with no
// persistence this banner just kept coming back. Remember the dismissal
// across page loads and stay quiet for the rest of that calendar day.
const DISMISS_KEY = "installPromptDismissedAt";

function dismissedToday(): boolean {
  const raw = localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  return new Date(raw).toDateString() === new Date().toDateString();
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    function onBeforeInstall(e: Event) {
      e.preventDefault();
      if (dismissedToday()) return;
      setDeferred(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setDeferred(null);
      setHidden(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString());
    setHidden(true);
  }

  if (!deferred || hidden) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 mx-auto flex max-w-sm items-center justify-between gap-3 rounded-lg border bg-card p-3 shadow-lg">
      <span className="text-sm">Install GeduSuite for quick access.</span>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Not now
        </Button>
        <Button
          size="sm"
          onClick={async () => {
            await deferred.prompt();
            const { outcome } = await deferred.userChoice;
            if (outcome === "dismissed") dismiss();
            setDeferred(null);
          }}
        >
          Install
        </Button>
      </div>
    </div>
  );
}
