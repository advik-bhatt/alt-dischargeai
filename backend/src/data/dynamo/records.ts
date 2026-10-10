import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DischargeRecord, ExpiredRecordRef, RecordStore } from "../records.js";

export interface DynamoOptions {
  tableName: string;
  region: string;
  /** http://localhost:8000 for DynamoDB Local; undefined for real AWS. */
  endpoint?: string;
}

export function createDynamoClient(opts: Pick<DynamoOptions, "region" | "endpoint">): DynamoDBClient {
  return new DynamoDBClient({
    region: opts.region,
    ...(opts.endpoint ? { endpoint: opts.endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
  });
}

/**
 * DynamoDB table `discharge_records`: partition key `tokenHash` (S), TTL enabled on `expiresAt` (N,
 * epoch seconds). `scripts/create-dynamo-table.ts` creates it. Items are stored exactly as
 * DischargeRecord (sealed fields are maps of base64 strings). AWS deletes expired items "typically
 * within a few days" of expiry, so the API checks `expiresAt` on every read and answers 410 first.
 * IAM: dynamodb:PutItem, GetItem, UpdateItem, DeleteItem, Scan (sweeper only) on the table.
 */
export class DynamoRecordStore implements RecordStore {
  readonly name = "dynamo" as const;
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  constructor(opts: DynamoOptions, client: DynamoDBClient = createDynamoClient(opts)) {
    this.table = opts.tableName;
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async put(record: DischargeRecord): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: record }));
  }

  async get(tokenHash: string): Promise<DischargeRecord | null> {
    const { Item } = await this.doc.send(new GetCommand({ TableName: this.table, Key: { tokenHash } }));
    return Item ? (Item as DischargeRecord) : null;
  }

  async update(tokenHash: string, patch: Partial<Omit<DischargeRecord, "tokenHash">>): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    entries.forEach(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
    });
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { tokenHash },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(tokenHash)",
      }),
    );
  }

  async delete(tokenHash: string): Promise<boolean> {
    const r = await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { tokenHash }, ReturnValues: "ALL_OLD" }));
    return !!r.Attributes;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<ExpiredRecordRef[]> {
    const { Items } = await this.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: "expiresAt <= :now",
        ProjectionExpression: "tokenHash, expiresAt, audioKey",
        ExpressionAttributeValues: { ":now": nowEpochSeconds },
        Limit: limit,
      }),
    );
    return (Items ?? []).map((i) => ({ tokenHash: String(i.tokenHash), expiresAt: Number(i.expiresAt), audioKey: i.audioKey ? String(i.audioKey) : undefined }));
  }

  async listProcessingBefore(iso: string): Promise<string[]> {
    const { Items } = await this.doc.send(
      new ScanCommand({
        TableName: this.table,
        FilterExpression: "#s = :p AND createdAt < :iso",
        ProjectionExpression: "tokenHash",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":p": "processing", ":iso": iso },
      }),
    );
    return (Items ?? []).map((i) => String(i.tokenHash));
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
