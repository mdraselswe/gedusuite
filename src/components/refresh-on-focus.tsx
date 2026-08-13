"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * How long this tab has to have been away before coming back to it is worth a
 * round trip.
 *
 * A page rendered on the server is a photograph of the moment it was asked
 * for, and it stays that way until something navigates. So a tab left open on
 * the sales list while an order was entered from another tab — or by somebody
 * else on another phone — kept showing the list as it was, with no hint that
 * it had aged. The fix people found was to reload by hand, which only works if
 * you already suspect the screen is lying to you.
 *
 * Ten seconds, because the flick between two tabs mid-task is not "away" —
 * that one is the same piece of work, and refetching a heavy list on every
 * flick would make the app feel slower rather than fresher.
 */
const STALE_AFTER_MS = 10_000;

/**
 * Refetches this tab's server data when the user comes back to it.
 *
 * Cheap on purpose: no polling, no socket, nothing running while nobody is
 * looking. It doesn't make two side-by-side tabs update each other live — for
 * that a tab has to be told, which is a different piece of work — but it does
 * mean the screen somebody is actually looking at is one they can trust.
 *
 * `router.refresh()` keeps client state: an open dialog stays open and a
 * half-typed form keeps what was typed. Only the server-rendered part is
 * replaced.
 */
export function RefreshOnFocus() {
  const router = useRouter();

  useEffect(() => {
    // When this tab stopped being the one in front; null while it is.
    let awaySince: number | null = null;

    function onAway() {
      // Switching tabs fires both `blur` and `visibilitychange`. The first one
      // to arrive owns the timestamp, so the second can't push it forward and
      // make a long absence look like a short one.
      if (awaySince === null) awaySince = Date.now();
    }

    function onBack() {
      const since = awaySince;
      awaySince = null;
      if (since === null || Date.now() - since < STALE_AFTER_MS) return;
      // Offline, the refresh can only fail, and failing here would replace a
      // page that is merely stale with one that is broken. Coming back online
      // is already handled: OutboxSync replays what was queued and refreshes.
      if (navigator.onLine === false) return;
      router.refresh();
    }

    function onVisibilityChange() {
      if (document.visibilityState === "hidden") onAway();
      else onBack();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    // Alt-tabbing to another window leaves this tab visible, so
    // visibilitychange never fires — on a desktop that is most of the "came
    // back to it" there is.
    window.addEventListener("blur", onAway);
    window.addEventListener("focus", onBack);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("focus", onBack);
    };
  }, [router]);

  return null;
}
