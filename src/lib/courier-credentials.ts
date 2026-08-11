import { randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";
import type { SteadfastCredentials } from "@/lib/steadfast";

/**
 * Reading and writing a courier's API credentials.
 *
 * Kept out of the actions file because both a server action and a webhook route
 * need it, and a "use server" module can only export actions.
 */

export type CourierApiState = {
  connected: boolean;
  /** Last four characters of the key, so a person can tell which one is stored. */
  keyHint: string | null;
  /** Goes in the courier portal's "callback URL" field. */
  webhookUrl: string | null;
  /**
   * Goes in the courier portal's "auth token (bearer)" field. Shown in full
   * because it has to be copied into another system — unlike the API key,
   * which this app only ever receives.
   */
  webhookSecret: string | null;
};

export function encryptCredentials(creds: SteadfastCredentials) {
  return { apiKeyEnc: encrypt(creds.apiKey), apiSecretEnc: encrypt(creds.secretKey) };
}

/** A fresh webhook path segment. 32 hex chars — guessing it is not a threat. */
export function newWebhookToken(): string {
  return randomBytes(16).toString("hex");
}

/** The bearer token the courier sends back. Longer, because it is the real check. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Whether a webhook request carries the right bearer token.
 *
 * Tolerant about the shape on purpose. The portal's field is labelled "auth
 * token (bearer)" and the obvious guess is `Authorization: Bearer <token>`,
 * but a courier that sends it bare, or under x-api-key, is a courier whose
 * webhooks would otherwise fail silently for days. The token still has to
 * match exactly; only where it is written is forgiven.
 *
 * Compared with timingSafeEqual, and only after a length check, because
 * timingSafeEqual throws on mismatched lengths rather than returning false.
 */
export function webhookSecretMatches(
  expected: string | null,
  headers: Headers,
): boolean {
  if (!expected) return false;
  const candidates = [
    headers.get("authorization")?.replace(/^Bearer\s+/i, ""),
    headers.get("x-api-key"),
    headers.get("x-auth-token"),
  ];
  for (const raw of candidates) {
    const got = raw?.trim();
    if (!got || got.length !== expected.length) continue;
    if (timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return true;
  }
  return false;
}

/**
 * The credentials for a courier row, or null if it has none stored.
 *
 * Returns null rather than throwing on a decrypt failure: that happens when
 * BACKUP_ENCRYPTION_KEY has changed under stored data, and the honest response
 * is "not connected, enter them again" — not a 500 on the orders page.
 */
export async function loadCourierCredentials(
  courierId: string,
): Promise<SteadfastCredentials | null> {
  const row = await prisma.courier.findUnique({
    where: { id: courierId },
    select: { apiKeyEnc: true, apiSecretEnc: true },
  });
  if (!row?.apiKeyEnc || !row.apiSecretEnc) return null;
  const apiKey = decrypt(row.apiKeyEnc);
  const secretKey = decrypt(row.apiSecretEnc);
  if (!apiKey || !secretKey) return null;
  return { apiKey, secretKey };
}

/**
 * The courier a webhook token belongs to — the whole auth check for the route.
 * The workspace slug comes along because the route needs it to recognise its
 * own invoice numbers.
 */
export async function courierByWebhookToken(token: string) {
  if (!token || token.length < 16) return null;
  return prisma.courier.findUnique({
    where: { webhookToken: token },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      webhookSecret: true,
      workspace: { select: { slug: true } },
    },
  });
}

export function webhookUrlFor(token: string | null): string | null {
  if (!token) return null;
  const base =
    process.env.NEXTAUTH_URL?.replace(/\/$/, "") ?? "https://app.gedushop.com";
  return `${base}/api/cron/steadfast/${token}`;
}

/** What the settings page shows about a courier's connection — never the key. */
export function apiStateOf(courier: {
  apiKeyEnc: string | null;
  webhookToken: string | null;
  webhookSecret: string | null;
}): CourierApiState {
  const key = courier.apiKeyEnc ? decrypt(courier.apiKeyEnc) : null;
  return {
    connected: !!key,
    keyHint: key ? `…${key.slice(-4)}` : null,
    webhookUrl: webhookUrlFor(courier.webhookToken),
    webhookSecret: courier.webhookSecret,
  };
}
