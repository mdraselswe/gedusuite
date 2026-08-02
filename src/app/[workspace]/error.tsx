"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Now that the workspace shell streams, the HTML head and chrome are already
 * flushed by the time a page's data fetch can fail — so a throw can no longer
 * be turned into an error *response*. Without a boundary here the connection
 * just dies mid-stream and the browser shows a bare ERR_FAILED page with no
 * hint of what went wrong. This keeps the failure inside the app.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" />
      </span>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          This page couldn&apos;t load. It&apos;s usually a temporary hiccup talking to the
          database — trying again normally fixes it.
        </p>
        {error.digest && (
          <p className="pt-1 font-mono text-xs text-muted-foreground">ref: {error.digest}</p>
        )}
      </div>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
