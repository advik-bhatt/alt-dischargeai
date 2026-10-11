/**
 * Writes, restores or removes ONE clearly fake sample summary in the DynamoDB table, so the read routes
 * (GET /llm-sumary, GET /translation, GET /p/:token) can be tried against a real entry without running
 * an ingest. The entry is built from the repo's synthetic Example 1 fixtures, has the fixed id
 * `sampledischargesummary`, a hand-written English `llm-summary` and a stored Spanish translation, no
 * `activeLinks` row, and the usual 30-day `expiresAt` (DynamoDB's TTL removes it by itself).
 *
 *   npm run sample-entry                 write it (leaves an existing sample alone)
 *   npm run sample-entry -- --reset      put it back to its original state (drops translations added since)
 *   npm run sample-entry -- --delete     remove it
 *
 * It only ever touches the item with that id, and refuses when that item is not marked as the sample
 * (`meta.sample`). It needs AWS credentials in the shell, because it reads the team secret to find the
 * table, or DYNAMO_ENDPOINT for DynamoDB Local. No SQL database is involved.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRuntimeEnv } from "../src/bootstrap.js";
import type { AiOutput } from "../src/contracts/aiOutput.js";
import { loadConfig, LINK_TTL_DAYS } from "../src/config.js";
import { DynamoSummaryStore } from "../src/docstore/dynamo.js";
import type { SummaryItem, SummaryStore } from "../src/docstore/types.js";

export const SAMPLE_ID = "sampledischargesummary";

/** The sample item as it is first written. Pure: the clock is passed in. */
export function buildSampleItem(now: Date, root: string = join(import.meta.dirname, "..")): SummaryItem {
  const fixtures = join(root, "fixtures");
  const read = <T>(file: string) => JSON.parse(readFileSync(join(fixtures, file), "utf8")) as T;
  return {
    uid: SAMPLE_ID,
    "sum-id": SAMPLE_ID,
    patientID: "sample-patient",
    "raw-text": readFileSync(join(fixtures, "discharge-summaries", "example-1-chf.txt"), "utf8"),
    "llm-summary": read<AiOutput>("offline/ai-output/example-1.en.json"),
    translations: { es: read<AiOutput>("offline/ai-output/example-1.es.json") },
    status: "ready",
    createdAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + LINK_TTL_DAYS * 24 * 3600,
    inputKind: "text",
    meta: { sample: true, provider: "hand-written sample (synthetic Example 1)" },
  };
}

export type SampleAction = "written" | "already there" | "reset" | "deleted" | "nothing to delete" | "refused";

/**
 * The whole rule in one place: only the item with the sample id is ever read or written, and only when
 * it is absent or marked `meta.sample`. Anything else with that id is refused, untouched.
 */
export async function applySample(store: SummaryStore, mode: "write" | "reset" | "delete", now: Date = new Date(), root?: string): Promise<{ action: SampleAction; item?: SummaryItem }> {
  const existing = await store.get(SAMPLE_ID);
  if (existing && !existing.meta?.sample) return { action: "refused" };
  if (mode === "delete") return { action: existing && (await store.delete(SAMPLE_ID)) ? "deleted" : "nothing to delete" };
  if (existing && mode === "write") return { action: "already there", item: existing };
  const item = buildSampleItem(now, root);
  await store.put(item);
  return { action: existing ? "reset" : "written", item };
}

const isMain = process.argv[1]?.endsWith("sample-entry.ts");
if (isMain) {
  const usage = "usage: npm run sample-entry [-- --reset | -- --delete]";
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    process.exit(0);
  }
  const unknown = args.filter((a) => a !== "--reset" && a !== "--delete");
  if (unknown.length || (args.includes("--reset") && args.includes("--delete"))) {
    console.error(`unrecognised arguments: ${unknown.join(" ") || "--reset with --delete"}\n${usage}`);
    process.exit(2);
  }

  const { env, secrets } = await loadRuntimeEnv();
  const config = loadConfig(env);
  if (secrets.source !== "secrets-manager" && !config.DYNAMO_ENDPOINT) {
    console.error("This script writes to the DynamoDB table. Start it with AWS credentials in the shell (it reads hackhealth/secret to find the table), or set DYNAMO_ENDPOINT for DynamoDB Local.");
    process.exit(2);
  }
  const store = new DynamoSummaryStore({ tableName: config.DYNAMO_TABLE, keyAttribute: config.DYNAMO_PK, region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });
  const mode = args.includes("--delete") ? "delete" : args.includes("--reset") ? "reset" : "write";
  const { action, item } = await applySample(store, mode);
  if (action === "refused") {
    console.error(`An item with id ${SAMPLE_ID} exists in ${store.describe} and is not marked as the sample (meta.sample). Not touching it.`);
    process.exit(3);
  }
  const tryIt = [`curl -s "http://localhost:4000/llm-sumary?sum-id=${SAMPLE_ID}"`, `curl -s "http://localhost:4000/translation?lang=es&sum_id=${SAMPLE_ID}"`, `curl -s "http://localhost:4000/translation?lang=zh&sum_id=${SAMPLE_ID}"`];
  console.log(
    JSON.stringify(
      item
        ? { table: store.describe, id: SAMPLE_ID, action: action === "already there" ? "already there, left as it is (use --reset to restore it)" : action === "reset" ? "reset to its original state" : action, translations: Object.keys(item.translations ?? {}), expiresAt: new Date(item.expiresAt * 1000).toISOString(), tryIt }
        : { table: store.describe, id: SAMPLE_ID, action },
      null,
      2,
    ),
  );
}
