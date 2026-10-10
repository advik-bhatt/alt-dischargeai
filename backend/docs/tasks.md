# DischargeAI backend: task list (Kiro tasks)

Branch `backend`. Every item below is done and committed on 2026-10-10; the suite is green at every commit (`npm test`, 84 of 84 at the end). A teammate opening this in Kiro continues from "Open" at the bottom.

## Precedence (the rule every task follows)

Advik's Granola note first, the team diagram where the note is silent, the real AWS resource names over both. Public surface: exactly the note's endpoints plus the diagram's additions.

## Done

- [x] T1 Move the API onto the fixed JSON contract: `POST /ingest` runs lane 3 (`src/pipeline/runPipeline.ts`) and stores raw text, the LLM response and the picked-language translation encrypted; `GET /summary`, `GET /translate`, `GET /jobs/:id` serve the contract. Removed: checklist endpoints, `/languages`, caregiver fields, the old agents and verify modules. Page markers from pdf-parse stripped in `src/extract/text.ts`. Tests rewritten.
- [x] T2 Demo clock as `DEMO_NOW` (`src/clock.ts`, pinned at boot) plus `scripts/sweep.ts`; `GET /audit` replaced by `scripts/show-audit.ts`; `/admin/*` removed.
- [x] T3 SQL on MariaDB/RDS via `mysql2` with TLS against `certs/global-bundle.pem` (`src/db/index.ts` `MySqlDb`, `DATABASE_URL` and `MYSQL_*` resolution, `CREATE DATABASE IF NOT EXISTS`), one portable schema with per-dialect rewrites (`src/db/migrate.ts`), `scripts/fetch-rds-bundle.sh` (AWS step 1), `scripts/check-sql.ts`; Postgres removed.
- [x] T4 Secrets Manager bootstrap (`src/secrets.ts`, `src/bootstrap.ts`): `hackhealth/secret` keys mapped to `MYSQL_*`, `DYNAMO_TABLE`, `DYNAMO_PK`; environment wins; names only in logs and `/health`.
- [x] T5 Document store on `discharge-summaries` with the single hash key `uid` (`<linkIdHash>#raw | #simplified | #translation#<lang>`) and TTL `expiresAt` (`src/docstore/dynamo.ts`), the SQL twin keyed by the same `uid`, `DOC_STORE=auto`, `scripts/setup-dynamo.ts` idempotent; the lane-4 record store and token module folded in.
- [x] T6 `POST /synthesize` (text mode and linkId mode, stale translations dropped, patient emailed once verified) and `GET /p/:token` on the shared handler (`src/routes/linkAccess.ts`).
- [x] T7 Audio in S3 `emraudio-rh` with SSE, boot-time probe and local fallback reported by `/health`, `scripts/ensure-s3-lifecycle.ts`; deletion receipts per item from the purge job, the DynamoDB Streams and S3 event handlers on `uid` keys, sinks sql, file, console, dynamo (`src/audit/*`).
- [x] T8 Offline fixtures for Example 1 in Mandarin and Arabic (`fixtures/offline/ai-output/example-1.{zh,ar}.json`), names and doses verbatim.
- [x] T9 OpenAPI rewritten for this surface with a test that pins documented paths to mounted routes (`test/openapi.test.ts`).
- [x] T10 `scripts/demo.sh` (the narrative), `.env.example`, `scripts/live-ingest.ts`, `scripts/verify-infra.ts`.
- [x] T11 Translation check accepts a digit standing in for once/twice (seen live in Mandarin) while still refusing a lost, changed or invented number.
- [x] T12 Verification: every public route curled offline, `npm run demo` exit 0, `npm run verify-infra -- --bedrock` (Secrets Manager, DynamoDB probe, S3 probe and lifecycle, both model ids), `npm run setup-dynamo` and `ensure-s3-lifecycle --check` with no changes needed, `LLM_PROVIDER=bedrock npm run live-ingest` on `us.anthropic.claude-sonnet-4-6` (Spanish at ingest, Mandarin on demand). Results under `fixtures/live-samples/`.
- [x] T13 README (precedence, lane table, team infrastructure, run in one command, demo narrative, env table, needs-a-key table, what `alt-backend` adds), docs refreshed.

## Open (for the team)

- [ ] O1 Run `npm run check-sql` from the EC2 host that reaches RDS on 3306 and confirm the migrations on MariaDB (not reachable from the build container).
- [ ] O2 Deploy `src/audit/streamHandler.ts` on the table's stream (OLD_IMAGE) and `src/audit/s3EventHandler.ts` on the bucket's lifecycle events, with `AUDIT_SINK` set.
- [ ] O3 Enable `SPEECH_PROVIDER=transcribe` on the EC2 box and dictate one clip end to end.
- [ ] O4 Person C: iterate `src/pipeline/prompts.ts`; `POST /synthesize { linkId }` re-runs a stored link after each change.
- [ ] O5 Front end: render `GET /p/:token` and `?language=` from `availableLanguages`; the email link is `${PATIENT_APP_URL}/s/<linkId>`.
