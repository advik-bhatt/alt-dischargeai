import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { DynamoSummaryStore } from "./dynamo.js";
import { LocalSummaryStore } from "./local.js";
import type { SummaryStore } from "./types.js";

/**
 * DOC_STORE=dynamo -> the team table; local -> the SQL twin; auto (default) -> dynamo when the
 * Secrets Manager bootstrap supplied the table name (so the team account is used as soon as AWS
 * credentials resolve), local otherwise.
 */
export function resolveDocStore(config: Pick<Config, "DOC_STORE">, secretResolved: boolean): "local" | "dynamo" {
  if (config.DOC_STORE === "auto") return secretResolved ? "dynamo" : "local";
  return config.DOC_STORE;
}

export function createSummaryStore(config: Config, db: Db, mode: "local" | "dynamo"): SummaryStore {
  if (mode === "dynamo") {
    return new DynamoSummaryStore({
      tableName: config.DYNAMO_TABLE,
      keyAttribute: config.DYNAMO_PK,
      region: config.AWS_REGION,
      endpoint: config.DYNAMO_ENDPOINT,
    });
  }
  return new LocalSummaryStore(db);
}

export type { SummaryStore, SummaryItem, SummaryPatch, SummaryStatus, SummaryMeta, InputKind } from "./types.js";
export { languagesOf } from "./types.js";
