import { prisma } from "@/lib/prisma";
import { decrypt, encrypt } from "@/lib/crypto";

/**
 * Which WooCommerce website a workspace talks to, and with what keys.
 *
 * It used to be three environment variables, which can describe exactly one
 * shop — fine for one business, impossible for a second customer. Now every
 * workspace can carry its own connection (WorkspaceIntegration, secrets
 * encrypted), and the environment remains as the fallback the original shop
 * keeps running on without any change of its own.
 */
export type WooConfig = {
  /** https://shop.example.com — no trailing slash. */
  base: string;
  /** Read-only keys: pulling orders. */
  readKey: string;
  readSecret: string;
  /** Write keys: catalogue edits and order-status mirroring. Fall back to read. */
  writeKey: string;
  writeSecret: string;
  source: "workspace" | "env";
};

const trimSlash = (u: string) => u.replace(/\/+$/, "");

/** The deployment-wide connection described by the environment, if any. */
export function envWooConfig(): WooConfig {
  return {
    // No default: a deployment with no WP_URL has no website, rather than
    // quietly talking to somebody else's.
    base: trimSlash(process.env.WP_URL ?? ""),
    readKey: process.env.WC_CONSUMER_KEY ?? "",
    readSecret: process.env.WC_CONSUMER_SECRET ?? "",
    writeKey: process.env.WC_WRITE_KEY || process.env.WC_CONSUMER_KEY || "",
    writeSecret: process.env.WC_WRITE_SECRET || process.env.WC_CONSUMER_SECRET || "",
    source: "env",
  };
}

export const hasReadKeys = (c: WooConfig | null | undefined): c is WooConfig =>
  Boolean(c && c.base && c.readKey && c.readSecret);

export const hasWriteKeys = (c: WooConfig | null | undefined): c is WooConfig =>
  Boolean(c && c.base && c.writeKey && c.writeSecret);

/**
 * The connection for one workspace, or null when it has none.
 *
 *  1. Its own saved connection, if it has saved a URL and keys.
 *  2. Otherwise the environment's — but only for the workspace named by
 *     WOO_WORKSPACE_SLUG. Without that restriction every customer's workspace
 *     would be reading and writing the first shop's website.
 *  3. If WOO_WORKSPACE_SLUG is not set at all, the environment applies to
 *     every workspace, which is exactly how a single-shop deployment behaved
 *     before this existed.
 */
export async function resolveWooConfig(workspaceId: string): Promise<WooConfig | null> {
  const row = await prisma.workspaceIntegration.findUnique({
    where: { workspaceId },
  });
  if (row?.wooUrl) {
    const readKey = row.wooConsumerKeyEnc ? (decrypt(row.wooConsumerKeyEnc) ?? "") : "";
    const readSecret = row.wooConsumerSecretEnc ? (decrypt(row.wooConsumerSecretEnc) ?? "") : "";
    const writeKey = (row.wooWriteKeyEnc ? decrypt(row.wooWriteKeyEnc) : null) || readKey;
    const writeSecret = (row.wooWriteSecretEnc ? decrypt(row.wooWriteSecretEnc) : null) || readSecret;
    if ((readKey && readSecret) || (writeKey && writeSecret)) {
      return {
        base: trimSlash(row.wooUrl),
        readKey: readKey || writeKey,
        readSecret: readSecret || writeSecret,
        writeKey,
        writeSecret,
        source: "workspace",
      };
    }
  }

  const only = process.env.WOO_WORKSPACE_SLUG;
  if (only) {
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    });
    if (ws?.slug !== only) return null;
  }
  const env = envWooConfig();
  return hasReadKeys(env) || hasWriteKeys(env) ? env : null;
}

/** A value to hand to the settings form: just enough to recognise what is stored. */
export function keyHint(enc: string | null | undefined): string | null {
  if (!enc) return null;
  const plain = decrypt(enc);
  return plain ? `…${plain.slice(-4)}` : null;
}

export { encrypt };
