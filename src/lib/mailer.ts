/**
 * Outgoing email, provider-neutral.
 *
 * Production sends through Resend's HTTP API when RESEND_API_KEY is set. With no
 * key the message is NOT lost silently: it goes to the server log and to an
 * in-memory outbox, which is what local development and the tests read. A
 * deployment that forgot the key therefore shows a clear warning in the logs
 * rather than users waiting for an email that never comes.
 */

export type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type MailResult =
  | { ok: true; id?: string; via: "resend" | "outbox" }
  | { ok: false; error: string };

const g = globalThis as { __mailOutbox?: Mail[] };

/** Messages "sent" without a provider. Newest last. */
export function outbox(): Mail[] {
  return (g.__mailOutbox ??= []);
}

export function clearOutbox() {
  g.__mailOutbox = [];
}

export function appUrl(): string {
  return (process.env.APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/$/, "");
}

export async function sendMail(mail: Mail): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    outbox().push(mail);
    if (process.env.NODE_ENV === "production") {
      console.warn(
        `[mailer] RESEND_API_KEY is not set - email to ${mail.to} was NOT delivered: "${mail.subject}"`,
      );
    } else if (process.env.NODE_ENV !== "test") {
      console.log(`[mailer] (dev) to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    }
    return { ok: true, via: "outbox" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        // Resend's shared sandbox sender works with no domain set up, to the
        // account owner only. Real sending needs MAIL_FROM on a verified domain.
        from: process.env.MAIL_FROM || "GeduSuite <onboarding@resend.dev>",
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Email provider answered ${res.status} ${body.slice(0, 200)}` };
    }
    const json = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: json.id, via: "resend" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Email send failed" };
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One consistent, plain transactional layout. */
export function actionMail(opts: {
  to: string;
  subject: string;
  heading: string;
  body: string;
  buttonLabel: string;
  url: string;
  footnote?: string;
}): Mail {
  const text = `${opts.heading}\n\n${opts.body}\n\n${opts.buttonLabel}: ${opts.url}\n\n${opts.footnote ?? ""}`.trim();
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">
<h2 style="margin:0 0 12px">${esc(opts.heading)}</h2>
<p style="line-height:1.5">${esc(opts.body)}</p>
<p><a href="${esc(opts.url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(opts.buttonLabel)}</a></p>
<p style="color:#666;font-size:13px;line-height:1.5">If the button does not work, copy this link:<br>${esc(opts.url)}</p>
<p style="color:#888;font-size:12px">${esc(opts.footnote ?? "")}</p></div>`;
  return { to: opts.to, subject: opts.subject, text, html };
}
