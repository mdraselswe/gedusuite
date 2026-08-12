import { z, type ZodError } from "zod";

/**
 * Turning a validation failure into something a form can point at.
 *
 * Every action in this app did the same thing with a Zod failure:
 * `parsed.error.issues[0]?.message`. The message survived and the path — the
 * one piece of information that says WHICH field is wrong — was dropped on the
 * floor. So "Amount must be > 0" arrived as a toast floating over a form with
 * eleven inputs, and finding the offending one was the user's problem.
 *
 * Zod has known the answer the whole time. This keeps it.
 */

/** A refusal, and the field it belongs to when there is one. */
export type FieldIssue = {
  message: string;
  /** Dotted path, e.g. "amount" or "items.0.unitPrice". */
  field?: string;
};

/**
 * The first thing wrong, with its field.
 *
 * First rather than all of them: these forms submit whole and a person fixes
 * one thing at a time, and a wall of red is worse at getting a form saved than
 * one clear sentence.
 */
export function firstIssue(error: ZodError): FieldIssue {
  const issue = error.issues[0];
  if (!issue) return { message: "Invalid input" };
  const field = issue.path.length ? issue.path.join(".") : undefined;
  return { message: issue.message, field };
}

/**
 * The shape every action returns. `field` is advisory — a form that doesn't
 * know the name simply shows the message, which is what all of them did
 * before, so nothing breaks by adding it.
 */
export type ActionFailure = { ok: false; error: string; field?: string };

/** `return failed(parsed.error)` — the whole of what those 35 lines were doing. */
export function failed(error: ZodError): ActionFailure {
  const { message, field } = firstIssue(error);
  return { ok: false, error: message, field };
}

/**
 * A checkbox, as a form sends one.
 *
 * `z.coerce.boolean()` cannot be used for this: it is `Boolean(value)` and
 * nothing more, so the strings "0" and "false" both arrive as true. A missing
 * field — which is how an unticked native checkbox submits — is false.
 */
export const checkboxField = z.preprocess(
  (v) => v === true || v === "1" || v === "on" || v === "true",
  z.boolean(),
);
