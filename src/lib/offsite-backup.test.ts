import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { openSnapshot, sealSnapshot, sigV4, signPut } from "@/lib/offsite-backup";

describe("SigV4 signer", () => {
  it("reproduces AWS's published PUT Object example", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
    const payloadHash = createHash("sha256").update("Welcome to Amazon S3.").digest("hex");
    expect(payloadHash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const r = sigV4({
      method: "PUT",
      canonicalUri: "/test%24file.text",
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        host: "examplebucket.s3.amazonaws.com",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": "20130524T000000Z",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash,
      region: "us-east-1",
      service: "s3",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(r.signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("builds a path-style PUT with an Authorization header", () => {
    const out = signPut(
      { endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "bk", accessKey: "AK", secretKey: "SK", region: "auto" },
      "gedusuite/ws 1/2026-10-10.json",
      Buffer.from("x"),
      new Date("2026-10-10T12:00:00.000Z"),
    );
    expect(out.url).toBe("https://acct.r2.cloudflarestorage.com/bk/gedusuite/ws%201/2026-10-10.json");
    expect(out.headers["x-amz-date"]).toBe("20261010T120000Z");
    expect(out.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261010\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});

describe("snapshot sealing", () => {
  it("round-trips, is not readable, and detects tampering", () => {
    process.env.BACKUP_ENCRYPTION_KEY = "unit-test-key";
    const json = JSON.stringify({ orders: [{ customer: "Nusrat Jahan", total: 1500 }] });
    const blob = sealSnapshot(json);
    expect(blob.toString("utf8")).not.toContain("Nusrat");
    expect(openSnapshot(blob)).toBe(json);
    blob[blob.length - 1] ^= 0xff;
    expect(() => openSnapshot(blob)).toThrow();
  });
});
