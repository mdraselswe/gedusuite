"use client";

import { useMemo } from "react";
import { usePathname, useRouter as useNextRouter } from "next/navigation";
import { broadcastRefresh } from "@/lib/live-refresh";

/**
 * Next's router, with `refresh()` also telling the app's other tabs.
 *
 * Every mutation in this app ends the same way — a server action returns and
 * the component calls `router.refresh()`. That is exactly the moment the other
 * tabs need to hear about, and there are 80-odd of them, so the announcement
 * is attached to the method rather than written out at each one. The import
 * line is the tell: a file that reads `from "@/lib/live-router"` refreshes
 * every tab, and one that reads `from "next/navigation"` refreshes only its
 * own.
 *
 * Deliberately only `refresh`. `push` and `replace` navigate this tab and mean
 * nothing to any other, and a component that wants a quiet refresh — the
 * listener in components/live-refresh.tsx, which must not answer a broadcast
 * with another broadcast — imports the real router instead.
 */
export function useRouter(): ReturnType<typeof useNextRouter> {
  const router = useNextRouter();
  // "/gedushop/sales/orders" -> "gedushop". Read from the path rather than
  // passed in, so a call site needs to know nothing about any of this — and
  // depended on as the string, not as the pathname it came from: Next's own
  // router is stable across navigations, and an effect that lists `router` in
  // its dependencies must not start re-running on every route change because
  // this wrapper handed it a new object.
  const workspace = usePathname().split("/")[1] ?? "";

  return useMemo(() => {
    // Delegation rather than a spread: a spread copies own properties, so it
    // would depend on Next's router being a plain object rather than anything
    // with methods on a prototype — and getting that wrong loses `push` and
    // `replace` app-wide. Inheriting from it keeps every method whatever its
    // shape, and overrides exactly one.
    const live: ReturnType<typeof useNextRouter> = Object.create(router);
    live.refresh = () => {
      router.refresh();
      broadcastRefresh(workspace);
    };
    return live;
  }, [router, workspace]);
}
