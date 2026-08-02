import { Skeleton } from "@/components/ui/skeleton";
import { PageSkeleton } from "@/components/ui/page-skeleton";

/**
 * Suspense fallback for AppShell itself, used by WorkspaceLayout while its
 * membership/workspace/prefs queries resolve. A segment's own loading.tsx
 * renders *inside* that segment's layout, so it can never stand in for the
 * layout — this has to be an explicit boundary in the layout instead.
 *
 * Dimensions mirror AppShell (w-64 sidebar, h-16 brand row, py-3 header) so
 * the real chrome swaps in without a layout jump.
 */
export function AppShellSkeleton() {
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r bg-background md:flex">
        <div className="flex h-16 shrink-0 items-center border-b px-4">
          <Skeleton className="h-6 w-28" />
        </div>
        <div className="flex-1 space-y-1 p-3">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t p-3">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-8 w-20" />
        </div>
      </aside>

      <div className="flex flex-1 flex-col md:pl-64">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-2 border-b bg-background px-4 py-3 md:justify-end">
          <div className="flex items-center gap-1 md:hidden">
            <Skeleton className="size-10 rounded-md" />
            <Skeleton className="h-6 w-24" />
          </div>
          <Skeleton className="size-10 rounded-md" />
        </header>
        <main className="flex-1 p-4 sm:p-6">
          <PageSkeleton />
        </main>
      </div>
    </div>
  );
}
