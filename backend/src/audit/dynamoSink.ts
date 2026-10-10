import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoClient } from "../data/dynamo/records.js";
import type { AuditSink, DeletionReceipt } from "./receipts.js";

/**
 * Audit table `discharge_audit`: partition key `tokenHash` (S), sort key `receiptId` (S), no TTL
 * (receipts are the proof that data was deleted and must outlive it). `scripts/create-dynamo-table.ts`
 * creates it next to discharge_records. IAM: dynamodb:PutItem, Query, Scan (show-audit only).
 */
export class DynamoAuditSink implements AuditSink {
  readonly name = "dynamo" as const;
  private readonly doc: DynamoDBDocumentClient;

  constructor(private readonly opts: { tableName: string; region: string; endpoint?: string }) {
    this.doc = DynamoDBDocumentClient.from(createDynamoClient(opts), { marshallOptions: { removeUndefinedValues: true } });
  }

  async append(receipt: DeletionReceipt): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.opts.tableName, Item: receipt }));
  }

  async list(limit = 1000): Promise<DeletionReceipt[]> {
    const { Items } = await this.doc.send(new ScanCommand({ TableName: this.opts.tableName, Limit: limit }));
    return ((Items ?? []) as DeletionReceipt[]).sort((a, b) => a.at.localeCompare(b.at));
  }

  async findByTokenHash(tokenHash: string): Promise<DeletionReceipt[]> {
    const { Items } = await this.doc.send(
      new QueryCommand({ TableName: this.opts.tableName, KeyConditionExpression: "tokenHash = :t", ExpressionAttributeValues: { ":t": tokenHash } }),
    );
    return (Items ?? []) as DeletionReceipt[];
  }
}
