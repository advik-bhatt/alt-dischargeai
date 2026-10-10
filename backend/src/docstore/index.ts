import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { DynamoDocumentStore } from "./dynamo.js";
import { LocalDocumentStore } from "./local.js";
import type { DocumentStore } from "./types.js";

/**
 * DOC_STORE=dynamo -> the team table; local -> the SQL twin; auto (default) -> dynamo when the
 * Secrets Manager bootstrap supplied the table name (so the team account is used as soon as AWS
 * credentials resolve), local otherwise.
 */
export function resolveDocStore(config: Pick<Config, "DOC_STORE">, secretResolved: boolean): "local" | "dynamo" {
  if (config.DOC_STORE === "auto") return secretResolved ? "dynamo" : "local";
  return config.DOC_STORE;
}

export function createDocumentStore(config: Config, db: Db, mode: "local" | "dynamo"): DocumentStore {
  if (mode === "dynamo") {
    return new DynamoDocumentStore({
      tableName: config.DYNAMO_TABLE,
      keyAttribute: config.DYNAMO_PK,
      region: config.AWS_REGION,
      endpoint: config.DYNAMO_ENDPOINT,
    });
  }
  return new LocalDocumentStore(db);
}

export type { DocumentStore, DocItem } from "./types.js";
export { SK, pkFor, uidFor, splitUid } from "./types.js";
