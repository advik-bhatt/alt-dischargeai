import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ensureBucket } from "../scripts/setup-s3.js";

type Handler = (input: Record<string, unknown>) => unknown;

/** A fake S3 client: each command class name maps to a handler; every call is recorded. */
function fakeS3(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = cmd.constructor.name;
      calls.push(name);
      const h = handlers[name];
      if (!h) throw Object.assign(new Error(`unexpected ${name}`), { name: "Unexpected" });
      return h(cmd.input);
    },
  };
  return { client: client as unknown as S3Client, calls };
}

const err = (name: string, status: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
const notFound = () => {
  throw err("NotFound", 404);
};

describe("scripts/setup-s3.ts ensureBucket (creates emrpdf-rh for the tasks doc)", () => {
  it("creates a missing bucket, blocks public access, sets AES256 and adds the 30-day rule", async () => {
    const { client, calls } = fakeS3({
      HeadBucketCommand: notFound,
      CreateBucketCommand: () => ({}),
      GetPublicAccessBlockCommand: () => {
        throw err("NoSuchPublicAccessBlockConfiguration", 404);
      },
      PutPublicAccessBlockCommand: () => ({}),
      GetBucketEncryptionCommand: () => {
        throw err("ServerSideEncryptionConfigurationNotFoundError", 404);
      },
      PutBucketEncryptionCommand: () => ({}),
      GetBucketLifecycleConfigurationCommand: () => {
        throw err("NoSuchLifecycleConfiguration", 404);
      },
      PutBucketLifecycleConfigurationCommand: () => ({}),
    });
    const r = await ensureBucket(client, "emrpdf-rh", "us-west-2", false);
    expect(r).toMatchObject({ bucket: "emrpdf-rh", existed: false, created: true, publicAccessBlocked: true, encryption: "AES256" });
    expect(r.lifecycle).toMatchObject({ rulePresent: true, wrote: true });
    expect(r.lifecycle.rules[0].expirationDays).toBe(30);
    expect(calls).toContain("CreateBucketCommand");
  });

  it("with --check reports a missing bucket and writes nothing", async () => {
    const { client, calls } = fakeS3({ HeadBucketCommand: notFound });
    const r = await ensureBucket(client, "emrpdf-rh", "us-west-2", true);
    expect(r).toMatchObject({ existed: false, created: false });
    expect(r.changes).toEqual(["bucket missing (not created: --check)"]);
    expect(calls).toEqual(["HeadBucketCommand"]);
  });

  it("says existence is unknown, never 'existed', when HeadBucket is denied", async () => {
    const { client, calls } = fakeS3({
      HeadBucketCommand: () => {
        throw err("Forbidden", 403);
      },
    });
    const r = await ensureBucket(client, "emrpdf-rh", "us-west-2", false);
    expect(r.existed).toBeNull();
    expect(r.created).toBe(false);
    expect(r.error).toMatch(/Forbidden/);
    expect(calls).toEqual(["HeadBucketCommand"]);
  });

  it("leaves an existing bucket's settings and 30-day rule alone", async () => {
    const { client, calls } = fakeS3({
      HeadBucketCommand: () => ({}),
      GetPublicAccessBlockCommand: () => ({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } }),
      GetBucketEncryptionCommand: () => ({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] } }),
      GetBucketLifecycleConfigurationCommand: () => ({ Rules: [{ ID: "autodelete", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: 30 } }] }),
    });
    const r = await ensureBucket(client, "emraudio-rh", "us-west-2", false);
    expect(r).toMatchObject({ existed: true, created: false, publicAccessBlocked: true, encryption: "AES256", changes: [] });
    expect(r.lifecycle).toMatchObject({ rulePresent: true, rule: "autodelete", wrote: false });
    expect(calls.filter((c) => c.startsWith("Put") || c.startsWith("Create"))).toEqual([]);
  });
});
