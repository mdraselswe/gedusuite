import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

/**
 * Off-site copy of a workspace snapshot, in any S3-compatible bucket
 * (Cloudflare R2, AWS S3, Backblaze B2, MinIO).
 *
 * Why this exists: the in-database backup lives in the same Neon project as the
 * data. If that project is lost, deleted by mistake or its credentials are
 * revoked, the backup goes with it. A copy somewhere else is what makes the
 * word "backup" true.
 *
 * Written against the plain S3 REST API with SigV4 rather than an SDK, so it
 * adds nothing to the bundle and has no moving dependency. Snapshots are
 * gzipped and encrypted (AES-256-GCM) before they leave: the bucket never holds
 * a customer's orders in readable form.
 *
 * Configured by env — BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY,
 * BACKUP_S3_SECRET_KEY, optionally BACKUP_S3_REGION (default "auto" for R2).
 * Unconfigured, everything here is a quiet no-op.
 */

type S3Config = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
};

export function offsiteConfig(): S3Config | null {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKey = process.env.BACKUP_S3_ACCESS_KEY;
  const secretKey = process.env.BACKUP_S3_SECRET_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    accessKey,
    secretKey,
    region: process.env.BACKUP_S3_REGION || "auto",
  };
}

// ── encryption (binary: iv | tag | ciphertext) ────────────────────────

function encKey(): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("BACKUP_ENCRYPTION_KEY or NEXTAUTH_SECRET must be set");
  return createHash("sha256").update(`offsite:${secret}`).digest();
}

export function sealSnapshot(json: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(json, "utf8"))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function openSnapshot(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encKey(), iv);
  decipher.setAuthTag(tag);
  const gz = Buffer.concat([decipher.update(body), decipher.final()]);
  return gunzipSync(gz).toString("utf8");
}

// ── SigV4 PUT ─────────────────────────────────────────────────────────

const sha256hex = (d: Buffer | string) => createHash("sha256").update(d).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const encodePath = (p: string) =>
  p
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");

/**
 * SigV4 for a request with no query string.
 * `headers` keys must be lower-case; every one of them is signed.
 */
export function sigV4(opts: {
  method: string;
  canonicalUri: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKey: string;
  secretKey: string;
  amzDate: string; // 20261010T120000Z
}): { authorization: string; signature: string; signedHeaders: string } {
  const date = opts.amzDate.slice(0, 8);
  const names = Object.keys(opts.headers).sort();
  const NL = String.fromCharCode(10);
  const canonicalHeaders = names.map((n) => `${n}:${opts.headers[n].trim()}${NL}`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    opts.method,
    opts.canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    opts.payloadHash,
  ].join(NL);

  const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    opts.amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join(NL);
  const kDate = hmac(`AWS4${opts.secretKey}`, date);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    signature,
    signedHeaders,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function signPut(
  cfg: S3Config,
  key: string,
  body: Buffer,
  now = new Date(),
): { url: string; headers: Record<string, string> } {
  const url = new URL(cfg.endpoint);
  const canonicalUri = encodePath(`/${cfg.bucket}/${key}`);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const payloadHash = sha256hex(body);
  const signed = sigV4({
    method: "PUT",
    canonicalUri,
    headers: {
      "content-type": "application/octet-stream",
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    payloadHash,
    region: cfg.region,
    service: "s3",
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    amzDate,
  });
  return {
    url: `${cfg.endpoint}${canonicalUri}`,
    headers: {
      "Content-Type": "application/octet-stream",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: signed.authorization,
    },
  };
}

export type OffsiteResult =
  | { ok: true; key: string; bytes: number }
  | { ok: false; skipped: true }
  | { ok: false; skipped?: false; error: string };

/** Encrypt and upload one workspace snapshot. Never throws. */
export async function uploadOffsiteSnapshot(
  workspaceId: string,
  json: string,
  at: Date = new Date(),
): Promise<OffsiteResult> {
  const cfg = offsiteConfig();
  if (!cfg) return { ok: false, skipped: true };
  try {
    const blob = sealSnapshot(json);
    const stamp = at.toISOString().replace(/[:.]/g, "-");
    const key = `gedusuite/${workspaceId}/${stamp}.json.gz.enc`;
    const { url, headers } = signPut(cfg, key, blob, at);
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(blob),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Bucket answered ${res.status} ${text.slice(0, 160)}` };
    }
    return { ok: true, key, bytes: blob.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Upload failed" };
  }
}
