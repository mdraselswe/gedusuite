/**
 * One place errors are reported from.
 *
 * Always logged. When SENTRY_DSN is set the event is also sent to Sentry over
 * its HTTP envelope endpoint — no SDK, so nothing is added to the bundle and
 * nothing can slow a request down: delivery is fire-and-forget.
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error("[error]", err.message, context ?? "", err.stack?.split("\n").slice(0, 4).join("\n"));

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    const publicKey = u.username;
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
      exception: { values: [{ type: err.name, value: err.message, stacktrace: undefined }] },
      extra: { ...context, stack: err.stack },
    };
    const body =
      JSON.stringify({ event_id: eventId, dsn }) +
      "\n" +
      JSON.stringify({ type: "event" }) +
      "\n" +
      JSON.stringify(event);
    void fetch(`${u.protocol}//${u.host}/api/${projectId}/envelope/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=gedusuite/1.0, sentry_key=${publicKey}`,
      },
      body,
    }).catch(() => undefined);
  } catch {
    /* reporting must never throw */
  }
}
