import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

/**
 * Single-use emailed tokens (verify address, reset password).
 *
 * Stored in NextAuth's VerificationToken table, but as a SHA-256 hash: a leaked
 * database row must not be a usable link. The identifier carries the purpose,
 * so a verification token can never be replayed as a reset token.
 */
export type TokenPurpose = "verify-email" | "reset-password";

const TTL_MS: Record<TokenPurpose, number> = {
  "verify-email": 24 * 60 * 60 * 1000,
  "reset-password": 30 * 60 * 1000,
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const identifierFor = (purpose: TokenPurpose, subject: string) => `${purpose}:${subject}`;

/** Issue a token for `subject` (a user id). Any earlier one for the same purpose is revoked. */
export async function issueToken(purpose: TokenPurpose, subject: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.verificationToken.deleteMany({ where: { identifier: identifierFor(purpose, subject) } }),
    prisma.verificationToken.create({
      data: {
        identifier: identifierFor(purpose, subject),
        token: sha(raw),
        expires: new Date(Date.now() + TTL_MS[purpose]),
      },
    }),
  ]);
  return raw;
}

/**
 * Use a token. Returns the subject it was issued for, or null if it is unknown,
 * expired, or for another purpose. Deleted on first successful use.
 */
export async function consumeToken(purpose: TokenPurpose, raw: string): Promise<string | null> {
  if (!raw || raw.length > 200) return null;
  const row = await prisma.verificationToken.findUnique({ where: { token: sha(raw) } });
  if (!row || !row.identifier.startsWith(`${purpose}:`)) return null;
  // Delete first: whoever deletes it owns it, so a double click cannot use it twice.
  const gone = await prisma.verificationToken.deleteMany({ where: { token: row.token } });
  if (gone.count !== 1) return null;
  if (row.expires.getTime() < Date.now()) return null;
  return row.identifier.slice(purpose.length + 1);
}
