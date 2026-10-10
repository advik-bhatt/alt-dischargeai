import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ExpiredObjectRef, ObjectStore, StoredObject } from "../objects.js";

/** The slice of S3Client the store uses; tests pass a fake. */
export interface S3Like {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand | HeadObjectCommand | HeadBucketCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface S3ObjectOptions {
  bucket: string;
  region: string;
  client?: S3Like;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * One S3 bucket (`emrpdf-rh` for PDFs, `emraudio-rh` for audio). Every object is written with
 * server-side encryption (SSE-S3, AES256). The bucket's 30-day lifecycle rule (scripts/setup-s3.ts
 * ensures it) deletes objects on day 30 and the S3 event handler in src/audit/s3EventHandler.ts
 * writes the deletion receipt. The purge job also deletes the object explicitly when the link
 * expires, so the lifecycle rule is the backstop.
 * IAM: s3:PutObject, s3:GetObject, s3:DeleteObject on the bucket's objects; s3:ListBucket for HeadBucket.
 */
export class S3ObjectStore implements ObjectStore {
  readonly name = "s3" as const;
  private readonly s3: S3Like;

  constructor(private readonly opts: S3ObjectOptions) {
    this.s3 = opts.client ?? new S3Client({ region: opts.region });
  }

  /** Boot-time probe with a hard timeout; throws when the bucket is unreachable or forbidden. */
  async headBucket(timeoutMs = 5000): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.opts.bucket }), { abortSignal: abort.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async put(input: StoredObject): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: input.key, Body: input.body, ContentType: input.contentType, ServerSideEncryption: "AES256" }));
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      const r = (await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentType?: string };
      const bytes = await r.Body?.transformToByteArray();
      return bytes ? { key, body: Buffer.from(bytes), contentType: r.ContentType } : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** HeadObject first so the receipt says whether anything was actually there. */
  async delete(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    return true;
  }

  async listExpired(): Promise<ExpiredObjectRef[]> {
    return []; // the bucket lifecycle rule does this on AWS
  }

  describe(): string {
    return `s3://${this.opts.bucket}`;
  }
}
