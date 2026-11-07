import { trimTrailingSlashes } from "@countersign/core";
import { AwsClient } from "aws4fetch";

/** Documents are shown through short-lived signed URLs (ARCHITECTURE §16: 5 minutes). */
export const SIGNED_URL_TTL_SECONDS = 300;

export interface UrlSigner {
  signedGetUrl(key: string, opts?: { expiresInSeconds?: number }): Promise<string>;
}

/**
 * Presigned GET URLs over R2's S3 API (the binding can't sign). Config is ARCHITECTURE §17's
 * `STORAGE_ENDPOINT` (https://<account>.r2.cloudflarestorage.com), `STORAGE_BUCKET`,
 * `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`.
 */
export function s3UrlSigner(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}): UrlSigner {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region ?? "auto",
  });
  const base = trimTrailingSlashes(config.endpoint);
  return {
    async signedGetUrl(key, opts = {}) {
      const ttl = opts.expiresInSeconds ?? SIGNED_URL_TTL_SECONDS;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 604_800) {
        throw new Error("signed URL lifetime must be 1 s to 7 days");
      }
      const path = [config.bucket, ...key.split("/")].map(encodeURIComponent).join("/");
      const signed: { url: string } = await client.sign(`${base}/${path}?X-Amz-Expires=${ttl}`, {
        method: "GET",
        aws: { signQuery: true },
      });
      return signed.url;
    },
  };
}
