"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * A labelled control, its hint, and its error — as one thing.
 *
 * There were 212 of these assembled by hand, each a div with a Label, a
 * control and sometimes a paragraph, and no two agreeing on the gap between
 * them. The more serious half is what none of them did: an action refusing
 * "Amount must be > 0" put that sentence in a toast floating over a form with
 * eleven inputs, and finding the one it meant was the reader's problem. Zod
 * always knew which field it was (see lib/form); nothing carried it here.
 *
 * `name` is what connects the two. Give the Field the same name the schema
 * uses, hand it the action's failure, and the right box turns red with the
 * message under it.
 */

/** What a form got back from an action, when it failed. */
export type FieldError = { error: string; field?: string } | null | undefined;

/** Does this failure belong to `name`? */
export function isFieldError(err: FieldError, name?: string): boolean {
  return !!(err && name && err.field === name);
}

export function Field({
  name,
  label,
  hint,
  /** The whole failure; the Field decides whether it is the one being blamed. */
  error,
  required,
  className,
  children,
}: {
  /** Matches the schema's field name — how an error finds its way here. */
  name?: string;
  label?: React.ReactNode;
  /** Always-on help. Shown until an error replaces it. */
  hint?: React.ReactNode;
  error?: FieldError;
  required?: boolean;
  className?: string;
  /** The control. Cloned with id/aria wiring when it's a single element. */
  children: React.ReactNode;
}) {
  const reactId = React.useId();
  // The control's own id wins. Generating one and pointing the label at it
  // while the input kept the id it already had would leave htmlFor aiming at
  // nothing — the label would stop focusing its own box, which is exactly the
  // thing a label is for.
  const childId =
    React.isValidElement(children)
      ? ((children.props as Record<string, unknown>).id as string | undefined)
      : undefined;
  const id = childId ?? (name ? `f-${name}-${reactId}` : reactId);
  const mine = isFieldError(error, name);
  const describedBy = mine ? `${id}-error` : hint ? `${id}-hint` : undefined;

  // The control gets its id and aria wiring without every caller repeating it.
  // Only for a single element child — anything else (a Select with a trigger,
  // a composite picker) keeps its own arrangement and just gets the label.
  //
  // `name` is deliberately NOT passed down. A control without one is left
  // without one: an unnamed input is absent from FormData on purpose — its
  // value is set by the submit handler — and quietly giving it a name here
  // would add a field to every one of those forms. The Field's own `name` is
  // for matching an error to a box and nothing else.
  const control = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id: (children.props as Record<string, unknown>).id ?? id,
        "aria-invalid": mine || undefined,
        "aria-describedby": describedBy,
      })
    : children;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && (
            <span aria-hidden className="text-muted-foreground">
              *
            </span>
          )}
        </Label>
      )}
      {control}
      {/* The error replaces the hint rather than stacking under it — two lines
          of small text under a box is how a form stops being read. */}
      {mine ? (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error!.error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/**
 * The failure that belongs to no field — "Partner not found", a treasury
 * overdraft, anything the schema didn't catch. Sits at the top of the form
 * where a toast used to be the only home for it.
 */
export function FormError({ error }: { error: FieldError }) {
  if (!error || error.field) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
    >
      {error.error}
    </p>
  );
}
