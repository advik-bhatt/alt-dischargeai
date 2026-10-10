/**
 * Prints the audit log: the event trail of one link, the deletion receipts, or the latest events.
 *   npm run show-audit -- --link <linkId>     everything that happened to one link (by its hash)
 *   npm run show-audit -- --receipts          deletion receipts only (what was deleted, when, by which mechanism)
 *   npm run show-audit                        the latest 200 events
 * Nothing printed here is PHI: the audit log stores link hashes, stages, counts and mechanisms only.
 */
import { createContext } from "../src/context.js";
import { hashLinkId, isLinkIdShaped } from "../src/crypto/linkId.js";
import type { AuditEntry } from "../src/db/repos/audit.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const args = process.argv.slice(2);
const linkArg = args.includes("--link") ? args[args.indexOf("--link") + 1] : undefined;
const receiptsOnly = args.includes("--receipts");
const asJson = args.includes("--json");

const ctx = await createContext({
  env: { ...process.env, LLM_PROVIDER: "offline", SPEECH_PROVIDER: "offline", EMAIL_TRANSPORT: "console", EMAIL_QUEUE: "none", PURGE_INTERVAL_MS: "0", LOG_LEVEL: "silent" },
  seed: false,
  resumeJobs: false,
});

let entries: AuditEntry[];
let heading: string;
if (linkArg) {
  if (!isLinkIdShaped(linkArg)) {
    console.error("--link expects the 22-character link id");
    process.exit(2);
  }
  const hash = hashLinkId(linkArg);
  entries = await ctx.audit.listForLink(hash);
  const link = await ctx.links.getByHash(hash);
  heading = `link ${hash.slice(0, 8)}: status=${link?.status ?? "unknown"} keyDestroyed=${link ? link.encKey === null : "?"} expiresAt=${link?.expiresAt ?? "?"} languages=${JSON.stringify(link?.languages ?? [])}`;
} else if (receiptsOnly) {
  entries = await ctx.audit.listByEvent("deletion.receipt");
  heading = `deletion receipts (${entries.length})`;
} else {
  entries = await ctx.audit.listRecent(200);
  heading = `latest ${entries.length} events`;
}
await ctx.close();

if (asJson) {
  console.log(JSON.stringify({ heading, entries }, null, 2));
} else {
  console.log(heading);
  for (const e of entries) {
    console.log(`  ${e.at}  ${e.actor.padEnd(8)}  ${e.event.padEnd(20)}  ${e.linkIdHash ? e.linkIdHash.slice(0, 8) : "-"}  ${JSON.stringify(e.details)}`);
  }
}
