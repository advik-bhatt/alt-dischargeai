/**
 * Exercises the team infrastructure once from wherever it runs, cleaning up after itself, and writes
 * a names-only report to fixtures/live-samples/infra.<date>.json:
 *   1. Secrets Manager GetSecretValue on hackhealth/secret (key names, never values)
 *   2. DynamoDB discharge-summaries: DescribeTable, DescribeTimeToLive, put/get/delete of one probe item
 *      (uid probe#<random>, expiresAt 10 minutes out, no patient data)
 *   3. S3 emraudio-rh: HeadBucket, put/get/delete of one small text object (SSE AES256), lifecycle rules
 *   4. --bedrock: one Converse tool call per verified model id on a three-line synthetic note
 *   5. MySQL over 3306 is attempted only with --mysql (it is not reachable from the build container)
 * AWS credentials come from the shell only. Nothing in the report or on stdout is a secret.
 *   npm run verify-infra -- --bedrock
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DescribeTableCommand, DescribeTimeToLiveCommand } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { DeleteObjectCommand, GetBucketLifecycleConfigurationCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadDotEnv } from "../src/dotenv.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { bootstrapSecrets } from "../src/secrets.js";
import { createDynamoClient } from "../src/docstore/dynamo.js";

loadDotEnv();
const args = process.argv.slice(2);
const withBedrock = args.includes("--bedrock");
const withMysql = args.includes("--mysql");
const log = createLogger("silent");
const report: Record<string, unknown> = { date: new Date().toISOString(), from: "build container", notes: [] as string[] };
const notes = report.notes as string[];
const timed = async <T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> => {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
};
const fail = (err: unknown) => `${(err as { name?: string }).name ?? "Error"}: ${String((err as Error).message ?? err).slice(0, 200)}`;

// 1. Secrets Manager
const { env, result: secrets } = await bootstrapSecrets({ ...process.env }, { log });
report.secretsManager = { source: secrets.source, arn: secrets.arn, region: secrets.region, keysApplied: secrets.applied, overriddenByEnv: secrets.overriddenByEnv, missingKeys: secrets.missingKeys, reason: secrets.reason ?? null, ms: secrets.ms };
const config = loadConfig(env);

// 2. DynamoDB
try {
  const client = createDynamoClient({ region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const described = await client.send(new DescribeTableCommand({ TableName: config.DYNAMO_TABLE }));
  const ttl = await client.send(new DescribeTimeToLiveCommand({ TableName: config.DYNAMO_TABLE }));
  const uid = `probe#${randomBytes(8).toString("hex")}`;
  const item = { [config.DYNAMO_PK]: uid, kind: "probe", expiresAt: Math.floor(Date.now() / 1000) + 600, createdAt: new Date().toISOString(), note: "verify-infra probe, no patient data" };
  const put = await timed(() => doc.send(new PutCommand({ TableName: config.DYNAMO_TABLE, Item: item })));
  const got = await timed(() => doc.send(new GetCommand({ TableName: config.DYNAMO_TABLE, Key: { [config.DYNAMO_PK]: uid } })));
  const del = await timed(() => doc.send(new DeleteCommand({ TableName: config.DYNAMO_TABLE, Key: { [config.DYNAMO_PK]: uid } })));
  const gone = await doc.send(new GetCommand({ TableName: config.DYNAMO_TABLE, Key: { [config.DYNAMO_PK]: uid } }));
  client.destroy();
  report.dynamodb = {
    table: config.DYNAMO_TABLE,
    keyAttribute: config.DYNAMO_PK,
    status: described.Table?.TableStatus,
    keySchema: described.Table?.KeySchema,
    itemCount: described.Table?.ItemCount,
    ttl: { status: ttl.TimeToLiveDescription?.TimeToLiveStatus, attribute: ttl.TimeToLiveDescription?.AttributeName },
    probe: { uid, put: `ok ${put.ms}ms`, get: got.result.Item ? `ok ${got.ms}ms` : "MISSING", delete: `ok ${del.ms}ms`, goneAfterDelete: !gone.Item },
    verified: !!got.result.Item && !gone.Item,
  };
} catch (err) {
  report.dynamodb = { table: config.DYNAMO_TABLE, verified: false, error: fail(err) };
}

// 3. S3
try {
  const s3 = new S3Client({ region: config.AWS_REGION });
  const Bucket = config.AUDIO_BUCKET;
  await s3.send(new HeadBucketCommand({ Bucket }));
  const Key = `probes/verify-infra-${randomBytes(6).toString("hex")}.txt`;
  const put = await timed(() => s3.send(new PutObjectCommand({ Bucket, Key, Body: Buffer.from("verify-infra probe, no patient data"), ContentType: "text/plain", ServerSideEncryption: "AES256" })));
  const got = await timed(async () => (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body?.transformToString("utf8"));
  const del = await timed(() => s3.send(new DeleteObjectCommand({ Bucket, Key })));
  let lifecycle: unknown = [];
  try {
    lifecycle = ((await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }))).Rules ?? []).map((r) => ({ id: r.ID, status: r.Status, expirationDays: r.Expiration?.Days ?? null, abortMultipartDays: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null, prefix: r.Prefix ?? r.Filter?.Prefix ?? "" }));
  } catch (err) {
    lifecycle = { error: fail(err) };
  }
  s3.destroy();
  report.s3 = { bucket: Bucket, probe: { key: Key, put: `ok ${put.ms}ms (SSE AES256)`, get: got.result === "verify-infra probe, no patient data" ? `ok ${got.ms}ms` : "MISMATCH", delete: `ok ${del.ms}ms` }, lifecycleRules: lifecycle, verified: got.result === "verify-infra probe, no patient data" };
} catch (err) {
  report.s3 = { bucket: config.AUDIO_BUCKET, verified: false, error: fail(err) };
}

// 4. Bedrock (optional)
if (withBedrock) {
  const { BedrockSimplifier } = await import("../src/pipeline/bedrock/simplify.js");
  const note = "Discharge Medications\nNew medications\n• Furosemide 40 mg by mouth once daily for swelling.\nContinue\n• Metoprolol succinate 50 mg once daily.\nReturn Precautions\n• Chest pain.";
  const models: Record<string, unknown> = {};
  for (const modelId of [config.BEDROCK_MODEL_ID, "us.anthropic.claude-haiku-4-5-20251001-v1:0"].filter((m, i, a) => a.indexOf(m) === i)) {
    try {
      const r = await timed(() => new BedrockSimplifier({ modelId, region: config.AWS_REGION, log }).simplify({ text: note }));
      models[modelId] = { verified: true, ms: r.ms, usage: r.result.usage, medications: r.result.output.medications.map((m) => `${m.name} ${m.dose} (${m.status})`), steps: r.result.output.steps.length, warnings: r.result.output.warnings.length };
    } catch (err) {
      models[modelId] = { verified: false, error: fail(err) };
    }
  }
  report.bedrock = { region: config.AWS_REGION, api: "Converse with toolConfig (tool-based JSON)", models };
} else {
  notes.push("Bedrock not exercised in this run (pass --bedrock); npm run live-ingest covers the full pipeline on Bedrock.");
}

// 5. MySQL (optional; port 3306 is not reachable from the build container)
if (withMysql) {
  try {
    const { openDb } = await import("../src/db/index.js");
    const { migrate } = await import("../src/db/migrate.js");
    const db = await timed(() => openDb({ ...config, DATABASE_URL: undefined }));
    const ran = await migrate(db.result);
    const version = await db.result.get<{ v: string }>("SELECT VERSION() AS v");
    await db.result.close();
    report.mysql = { connection: db.result.describe, serverVersion: version?.v, migrationsApplied: ran, connectMs: db.ms, verified: db.result.dialect === "mysql" };
  } catch (err) {
    report.mysql = { host: config.MYSQL_HOST ?? null, verified: false, error: fail(err) };
  }
} else {
  report.mysql = { host: config.MYSQL_HOST ?? null, port: config.MYSQL_PORT, user: config.MYSQL_USER ?? null, database: config.MYSQL_DATABASE, tlsBundle: config.RDS_CA_BUNDLE, verified: false, note: "not exercised: port 3306 is not reachable from the build container; run with --mysql from the EC2 host" };
}

const dir = join(import.meta.dirname, "..", "fixtures", "live-samples");
mkdirSync(dir, { recursive: true });
const file = join(dir, `infra.${String(report.date).slice(0, 10)}.json`);
const text = JSON.stringify(report, null, 2) + "\n";
for (const v of [config.MYSQL_PASSWORD, process.env.AWS_SECRET_ACCESS_KEY, process.env.AWS_SESSION_TOKEN, process.env.AWS_ACCESS_KEY_ID].filter((x): x is string => !!x && x.length > 8)) {
  if (text.includes(v)) {
    console.error("refusing to write a report that contains a secret value");
    process.exit(1);
  }
}
writeFileSync(file, text);
console.log(text);
console.log(`wrote ${file}`);
