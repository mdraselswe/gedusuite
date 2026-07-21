"use client";

import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type ConfirmOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** Red confirm button for deletes/removals. */
  destructive?: boolean;
};

type Pending = { opts: ConfirmOptions; resolve: (v: boolean) => void };

// Module-level bridge: `confirmDialog()` is callable from any client component
// without threading context/hooks through every call site. The single
// <ConfirmDialogHost /> in the root layout registers itself here on mount.
let opener: ((opts: ConfirmOptions) => Promise<boolean>) | null = null;

/**
 * Styled drop-in replacement for window.confirm — resolves true on confirm,
 * false on cancel/dismiss. Falls back to the native dialog if the host isn't
 * mounted (never expected in practice).
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (!opener) {
    return Promise.resolve(
      window.confirm(opts.description ? `${opts.title}\n\n${opts.description}` : opts.title),
    );
  }
  return opener(opts);
}

/** Mount once (root layout). Renders the app-wide confirmation modal. */
export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    opener = (opts) => new Promise<boolean>((resolve) => setPending({ opts, resolve }));
    return () => {
      opener = null;
    };
  }, []);

  function close(value: boolean) {
    pending?.resolve(value);
    setPending(null);
  }

  const opts = pending?.opts;

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && close(false)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-full ${
                opts?.destructive
                  ? "bg-destructive/10 text-destructive"
                  : "bg-primary/10 text-primary"
              }`}
            >
              <TriangleAlert className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 pt-0.5">
              <DialogTitle>{opts?.title}</DialogTitle>
              {opts?.description && (
                <DialogDescription className="wrap-break-word">
                  {opts.description}
                </DialogDescription>
              )}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => close(false)}>
            {opts?.cancelText ?? "Cancel"}
          </Button>
          <Button
            variant={opts?.destructive ? "destructive" : "default"}
            onClick={() => close(true)}
            autoFocus
          >
            {opts?.confirmText ?? "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
