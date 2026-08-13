"use client";

import { useEffect } from "react";
// Deliberately the real router, not lib/live-router: this component answers
// other tabs' broadcasts, and a refresh that broadcast in turn would have two
// tabs refreshing each other for as long as they stayed open.
import { useRouter } from "next/navigation";
import { onRefreshSignal } from "@/lib/live-refresh";

/**
 * How long this tab has to have been away before coming back to it is worth a
 * round trip.
 *
 * A page rendered on the server is a photograph of the moment it was asked
 * for, and it stays that way until something navigates. So a tab left open on
 * the sales list while an order was entered elsewhere kept showing the list as
 * it was, with no hint that it had aged. The fix people found was to reload by
 * hand, which only works if you already suspect the screen is lying to you.
 *
 * Ten seconds, because the flick between two tabs mid-task is not "away" —
 * that one is the same piece of work, and refetching a heavy list on every
 * flick would make the app feel slower rather than fresher.
 */
const STALE_AFTER_MS = 10_000;

/**
 * How long to wait for more signals before acting on one.
 *
 * A single user action broadcasts once, so this is not usually doing anything.
 * It is here for the bursts: two people saving at the same moment, or an
 * offline queue replaying six queued writes on reconnect, which would
 * otherwise be six refreshes of the same page arriving in a second.
 */
const COALESCE_MS = 400;

/**
 * Keeps this tab's server data honest, as cheaply as the situation allows.
 *
 * Two ways in, one way out:
 *
 * - Another tab in this browser saved something, and said so (lib/live-refresh).
 *   A visible tab refetches after a short pause; a hidden one only remembers
 *   that it needs to, because refetching a page nobody is looking at spends a
 *   render on an answer that may be stale again before it is read. This is
 *   what keeps the fan-out at one tab however many are open.
 * - The user came back to this tab after being away long enough for it to have
 *   aged. This one also covers the changes a broadcast can't: another phone,
 *   another person, the WooCommerce webhook.
 *
 * No polling and no socket: nothing runs while nobody is looking.
 *
 * `router.refresh()` keeps client state — an open dialog stays open and a
 * half-typed form keeps what was typed. Only the server-rendered part is
 * replaced.
 */
export function LiveRefresh({ workspace }: { workspace: string }) {
  const router = useRouter();

  useEffect(() => {
    // When this tab stopped being the one in front; null while it is.
    let awaySince: number | null = null;
    // Something changed that this tab hasn't picked up yet.
    let stale = false;
    let coalescing: ReturnType<typeof setTimeout> | null = null;

    function refreshNow() {
      coalescing = null;
      // Offline, the refresh can only fail, and failing here would replace a
      // page that is merely out of date with one that is broken. The flag
      // stays up, so returning to the tab picks it up; OutboxSync separately
      // replays and refreshes whatever was queued while the connection was
      // gone.
      if (navigator.onLine === false) return;
      stale = false;
      router.refresh();
    }

    const stopListening = onRefreshSignal((signal) => {
      if (signal.workspace !== workspace) return;
      stale = true;
      // A hidden tab is told, and waits. It refetches when somebody looks at
      // it, in onBack below.
      if (document.visibilityState === "hidden") return;
      if (coalescing) clearTimeout(coalescing);
      coalescing = setTimeout(refreshNow, COALESCE_MS);
    });

    function onAway() {
      // Switching tabs fires both `blur` and `visibilitychange`. The first one
      // to arrive owns the timestamp, so the second can't push it forward and
      // make a long absence look like a short one.
      if (awaySince === null) awaySince = Date.now();
    }

    function onBack() {
      const since = awaySince;
      awaySince = null;
      const aged = since !== null && Date.now() - since >= STALE_AFTER_MS;
      if (!stale && !aged) return;
      if (coalescing) clearTimeout(coalescing);
      refreshNow();
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
      stopListening();
      if (coalescing) clearTimeout(coalescing);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("focus", onBack);
    };
  }, [router, workspace]);

  return null;
}
