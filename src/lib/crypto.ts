import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "crypto";

// AES-256-GCM at-rest encryption for stored OAuth tokens. The key is derived
// from BACKUP_ENCRYPTION_KEY (fall back to NEXTAUTH_SECRET) via SHA-256.
function key(): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("BACKUP_ENCRYPTION_KEY or NEXTAUTH_SECRET must be set");
  return createHash("sha256").update(secret).digest();
}

/** Encrypt a string → "iv:tag:ciphertext" (all base64). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

/** Decrypt a value produced by encrypt(). Returns null if malformed/invalid. */
export function decrypt(payload: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = payload.split(":");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}
