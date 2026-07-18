import { google } from "googleapis";
import { decrypt } from "@/lib/crypto";

/**
 * Per-user personal backup OAuth. Reuses the existing Google OAuth client
 * (GOOGLE_CLIENT_ID/SECRET) but with a distinct callback + narrower scopes than
 * sign-in: only file-scoped Drive + Sheets, never full Drive access.
 */
export const PERSONAL_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets",
];

export function personalBackupConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(): string {
  const base = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  return `${base}/api/google/personal/callback`;
}

export function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri(),
  );
}

/** Consent URL — offline access + forced consent so we always get a refresh token. */
export function consentUrl(state: string): string {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: PERSONAL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

export async function exchangeCode(code: string) {
  const { tokens } = await oauthClient().getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
}

/** Build an authed client from a stored (encrypted) connection. */
export function clientForConnection(conn: {
  accessToken: string;
  refreshToken: string | null;
  expiryDate: bigint | null;
}) {
  const client = oauthClient();
  client.setCredentials({
    access_token: decrypt(conn.accessToken) ?? undefined,
    refresh_token: conn.refreshToken ? (decrypt(conn.refreshToken) ?? undefined) : undefined,
    expiry_date: conn.expiryDate ? Number(conn.expiryDate) : undefined,
  });
  return client;
}

export async function revokeToken(accessTokenEnc: string): Promise<void> {
  const token = decrypt(accessTokenEnc);
  if (!token) return;
  try {
    await oauthClient().revokeToken(token);
  } catch {
    // Already revoked/expired — nothing to do.
  }
}
