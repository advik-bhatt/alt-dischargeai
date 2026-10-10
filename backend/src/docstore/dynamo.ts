import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { uidFor, type DocItem, type DocumentStore } from "./types.js";

export interface DynamoOptions {
  tableName: string;
  /** Hash key attribute name (the secret's dynamodb-table-pk), `uid` on the team table. */
  keyAttribute?: string;
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

/** The minimum of DynamoDBDocumentClient the store uses; tests pass a fake. */
export interface DocClient {
  send(command: PutCommand | GetCommand | DeleteCommand | ScanCommand): Promise<unknown>;
}

interface DynamoItem {
  pk: string;
  sk: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
  expiresAt: number;
  createdAt: string;
}

function fromDynamo(i: DynamoItem): DocItem {
  return {
    pk: i.pk,
    sk: i.sk,
    ciphertext: Buffer.from(i.ciphertext),
    iv: Buffer.from(i.iv),
    tag: Buffer.from(i.tag),
    keyVersion: Number(i.keyVersion),
    expiresAt: Number(i.expiresAt),
    createdAt: i.createdAt,
  };
}

/**
 * DynamoDB table `discharge-summaries` (account 183815333909, us-west-2): hash key `uid` (S), no
 * sort key, TTL enabled on `expiresAt` (N, epoch seconds). Items are written with server-side
 * encryption by DynamoDB and, before that, sealed with the link's data key by SecureDocs, so the
 * table never holds plaintext. With a single hash key, per-link listing and the backstop sweep are
 * filtered scans; at hackathon scale that is fine, and a sort key or GSI is the production step.
 * `scripts/setup-dynamo.ts` creates the table when missing and enables TTL idempotently.
 * IAM: dynamodb:PutItem, GetItem, DeleteItem, Scan on the table (DescribeTable, UpdateTimeToLive,
 * DescribeTimeToLive, CreateTable for the setup script).
 */
export class DynamoDocumentStore implements DocumentStore {
  readonly name = "dynamo" as const;
  readonly describe: string;
  private readonly doc: DocClient;
  private readonly table: string;
  private readonly key: string;

  constructor(opts: DynamoOptions, docClient?: DocClient) {
    this.table = opts.tableName;
    this.key = opts.keyAttribute ?? "uid";
    this.describe = `dynamodb:${opts.endpoint ?? opts.region}/${this.table} (key=${this.key}, ttl=expiresAt)`;
    this.doc = docClient ?? DynamoDBDocumentClient.from(createDynamoClient(opts), { marshallOptions: { removeUndefinedValues: true } });
  }

  private keyFor(pk: string, sk: string): Record<string, string> {
    return { [this.key]: uidFor(pk, sk) };
  }

  async put(item: DocItem): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...this.keyFor(item.pk, item.sk), ...item } }));
  }

  async get(pk: string, sk: string): Promise<DocItem | null> {
    const { Item } = (await this.doc.send(new GetCommand({ TableName: this.table, Key: this.keyFor(pk, sk) }))) as { Item?: DynamoItem };
    return Item ? fromDynamo(Item) : null;
  }

  private async scanAll(input: { FilterExpression: string; ExpressionAttributeValues: Record<string, unknown>; ExpressionAttributeNames?: Record<string, string>; ProjectionExpression?: string }, limit = Number.MAX_SAFE_INTEGER): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = (await this.doc.send(new ScanCommand({ TableName: this.table, ...input, ExclusiveStartKey }))) as ScanCommandOutput;
      for (const it of page.Items ?? []) {
        out.push(it);
        if (out.length >= limit) return out;
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  async list(pk: string, skPrefix?: string): Promise<DocItem[]> {
    const items = await this.scanAll({
      FilterExpression: skPrefix ? "pk = :pk AND begins_with(sk, :p)" : "pk = :pk",
      ExpressionAttributeValues: skPrefix ? { ":pk": pk, ":p": skPrefix } : { ":pk": pk },
    });
    return items.map((i) => fromDynamo(i as unknown as DynamoItem)).sort((a, b) => a.sk.localeCompare(b.sk));
  }

  async deleteAll(pk: string): Promise<number> {
    const items = await this.scanAll({ FilterExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ProjectionExpression: "pk, sk" });
    for (const it of items) await this.delete(String(it.pk), String(it.sk));
    return items.length;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<Pick<DocItem, "pk" | "sk">[]> {
    const items = await this.scanAll({ FilterExpression: "expiresAt <= :now", ExpressionAttributeValues: { ":now": nowEpochSeconds }, ProjectionExpression: "pk, sk" }, limit);
    return items.map((i) => ({ pk: String(i.pk), sk: String(i.sk) }));
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: this.keyFor(pk, sk) }));
  }
}
