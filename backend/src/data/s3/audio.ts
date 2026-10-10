import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AudioObject, AudioStore, ExpiredAudioRef } from "../audio.js";

export interface S3AudioOptions {
  bucket: string;
  region: string;
  client?: S3Client;
}

/**
 * The S3 audio bucket. Every object is written with server-side encryption (SSE-S3, AES256); the
 * bucket's lifecycle rule (`scripts/put-s3-lifecycle.ts`, Expiration 30 days) deletes objects on
 * day 30 and the S3 event handler in src/audit/s3EventHandler.ts writes the deletion receipt.
 * IAM: s3:PutObject, s3:GetObject, s3:DeleteObject on the bucket's objects.
 */
export class S3AudioStore implements AudioStore {
  readonly name = "s3" as const;
  private readonly s3: S3Client;

  constructor(private readonly opts: S3AudioOptions) {
    this.s3 = opts.client ?? new S3Client({ region: opts.region });
  }

  async put(input: AudioObject): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.opts.bucket, Key: input.key, Body: input.body, ContentType: input.contentType, ServerSideEncryption: "AES256" }),
    );
  }

  async get(key: string): Promise<AudioObject | null> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      const bytes = await r.Body?.transformToByteArray();
      return bytes ? { key, body: Buffer.from(bytes), contentType: r.ContentType } : null;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<boolean> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    return true;
  }

  async listExpired(): Promise<ExpiredAudioRef[]> {
    return []; // the bucket lifecycle rule does this on AWS
  }

  describe(): string {
    return `s3://${this.opts.bucket}`;
  }
}
