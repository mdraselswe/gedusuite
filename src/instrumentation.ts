import type { Instrumentation } from "next";

/** Every unhandled server-side error in a request ends up here. */
export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  const { reportError } = await import("@/lib/report-error");
  reportError(err, { path: request.path, method: request.method });
};
