import { PageSkeleton } from "@/components/ui/page-skeleton";

/**
 * Catch-all fallback for any workspace route that doesn't ship its own
 * loading.tsx. It renders inside AppShell, so it's page content only — the
 * chrome's fallback has to live in layout.tsx (see AppShellSkeleton), because
 * a segment's loading.tsx sits inside that segment's own layout.
 */
export default function Loading() {
  return <PageSkeleton />;
}
