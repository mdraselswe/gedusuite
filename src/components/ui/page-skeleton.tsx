import { Skeleton } from "@/components/ui/skeleton";

/**
 * Instant fallback for a workspace page while its data loads (wired in via
 * each route's loading.tsx) — so cold serverless/DB latency shows a shell
 * instead of a blank screen. Mirrors DataTable's row shape closely enough
 * to avoid a layout jump when the real content swaps in.
 */
export function PageSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  );
}
