"use client";

/**
 * Telling the app's other tabs that something changed.
 *
 * The signal is a BroadcastChannel message: same-origin, in-browser, no
 * network and no server involvement at all. What costs something is what the
 * listener does with it — a router.refresh() is a real round trip and a real
 * render — so the rules about when to act on one live in the component that
 * receives them (components/live-refresh.tsx), not here.
 *
 * The channel is a per-tab singleton and is never closed. Two things follow
 * from that, both wanted: a tab cannot receive its own message (the spec
 * delivers to every channel object except the sender, and there is only one
 * per tab), and there is no lifecycle to get wrong.
 */

/** Namespaced so nothing else on the origin can be mistaken for a signal. */
const CHANNEL = "gedusuite:refresh";

/** Which workspace changed. A second workspace open in another tab has no
 *  reason to refetch because this one saved something. */
export type RefreshSignal = { workspace: string };

let channel: BroadcastChannel | null = null;

/** null where there is no BroadcastChannel: during SSR, and in the older
 *  Safari the shop's phones may still be running. Everything below then
 *  quietly does nothing, which leaves the app exactly as it was before any of
 *  this — stale until the tab is returned to. */
function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

/** Announce a change this tab just made. Only ever called for a real mutation
 *  — see lib/live-router.ts, which is the one caller. */
export function broadcastRefresh(workspace: string) {
  getChannel()?.postMessage({ workspace } satisfies RefreshSignal);
}

/** Listen for other tabs' changes. Returns its own unsubscribe. */
export function onRefreshSignal(handler: (signal: RefreshSignal) => void): () => void {
  const bc = getChannel();
  if (!bc) return () => {};
  const listener = (event: MessageEvent) => {
    const data: unknown = event.data;
    // Anything on the origin can post here; a message that isn't ours is
    // ignored rather than trusted into a refresh.
    if (!data || typeof data !== "object") return;
    const workspace = (data as { workspace?: unknown }).workspace;
    if (typeof workspace !== "string") return;
    handler({ workspace });
  };
  bc.addEventListener("message", listener);
  return () => bc.removeEventListener("message", listener);
}
