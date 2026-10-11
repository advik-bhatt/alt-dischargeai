# DischargeAI backend: task list (Kiro tasks)

Branch `backend`. Every item below is done and committed on 2026-10-10 and 2026-10-11; the suite is green at every commit. A teammate opening this in Kiro continues from "Open" at the bottom.

## Precedence (the rule every task follows)

The team's backend tasks doc first, Advik's Granola note second, the team diagram where both are silent, the real AWS resource names over all of them. Public surface: the tasks doc's routes, the note's endpoints, the diagram's additions.

## Done

- [x] T1 Move the API onto the fixed JSON contract: `POST /ingest` runs lane 3 (`src/pipeline/runPipeline.ts`) and stores the raw text and the LLM response (later reworked to the tasks doc's single plain item, and later still translation was taken out of ingestion, see B7); `GET /summary`, `GET /translate`, `GET /jobs/:id` serve the contract. Removed: checklist endpoints, `/languages`, caregiver fields, the old agents and verify modules. Page markers from pdf-parse stripped in `src/extract/text.ts`. Tests rewritten.
- [x] T2 Demo clock as `DEMO_NOW` (`src/clock.ts`, pinned at boot) plus `scripts/sweep.ts`; `GET /audit` replaced by `scripts/show-audit.ts`; `/admin/*` removed.
- [x] T3 SQL on MariaDB/RDS via `mysql2` with TLS against `certs/global-bundle.pem` (`src/db/index.ts` `MySqlDb`, `DATABASE_URL` and `MYSQL_*` resolution, `CREATE DATABASE IF NOT EXISTS`), one portable schema with per-dialect rewrites (`src/db/migrate.ts`), `scripts/fetch-rds-bundle.sh` (AWS step 1), `scripts/check-sql.ts`; Postgres removed.
- [x] T4 Secrets Manager bootstrap (`src/secrets.ts`, `src/bootstrap.ts`): `hackhealth/secret` keys mapped to `MYSQL_*`, `DYNAMO_TABLE`, `DYNAMO_PK`; environment wins; names only in logs and `/health`.
- [x] T5 Document store on `discharge-summaries` with the single hash key `uid` and TTL `expiresAt` (since replaced by the tasks doc's one item per summary, below) (`src/docstore/dynamo.ts`), the SQL twin keyed by the same `uid`, `DOC_STORE=auto`, `scripts/setup-dynamo.ts` idempotent; the lane-4 record store and token module folded in.
- [x] T6 `POST /synthesize` (text mode and linkId mode, stale translations dropped, patient emailed once verified) and `GET /p/:token` on the shared handler (`src/routes/linkAccess.ts`).
- [x] T7 Audio in S3 `emraudio-rh` with SSE, boot-time probe and local fallback reported by `/health`, `scripts/ensure-s3-lifecycle.ts`; deletion receipts per item from the purge job, the DynamoDB Streams and S3 event handlers on `uid` keys, sinks sql, file, console, dynamo (`src/audit/*`).
- [x] T8 Offline fixtures for Example 1 in Mandarin and Arabic (`fixtures/offline/ai-output/example-1.{zh,ar}.json`), names and doses verbatim.
- [x] T9 OpenAPI rewritten for this surface with a test that pins documented paths to mounted routes (`test/openapi.test.ts`).
- [x] T10 `scripts/demo.sh` (the narrative), `.env.example`, `scripts/live-ingest.ts`, `scripts/verify-infra.ts`.
- [x] T11 Translation check accepts a digit standing in for once/twice (seen live in Mandarin) while still refusing a lost, changed or invented number.
- [x] T12 Verification: every public route curled offline, `npm run demo` exit 0, `npm run verify-infra -- --bedrock` (Secrets Manager, DynamoDB probe, S3 probe and lifecycle, both model ids), `npm run setup-dynamo` and `ensure-s3-lifecycle --check` with no changes needed, `LLM_PROVIDER=bedrock npm run live-ingest` on `us.anthropic.claude-sonnet-4-6` (Spanish at ingest, Mandarin on demand). Results under `fixtures/live-samples/`.
- [x] T13 README (precedence, lane table, team infrastructure, run in one command, demo narrative, env table, needs-a-key table, what `alt-backend` adds), docs refreshed.

## The team's backend tasks doc

- [x] B0 Rework onto the tasks doc: `activeLinks` table and caregiver columns, one plain DynamoDB item per summary (`uid` = `sumId`, `sum-id`, `raw-text`, `llm-summary`, `translations`), `emrpdf-rh` object store, Node 24 (`engines`, `.nvmrc`), demo on the new routes.
- [x] B1 `GET /patients` returns exactly `ID, DOB, FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName`; OpenAPI `Patient` pinned to the same keys by a test.
- [x] B2 `pdfToText` (`src/extract/pdfToText.ts`) with a one-page sample PDF carried inline in the README curl and tested line for line.
- [x] B3 `POST /ingest` JSON `{ data, type, patientID }`: 202 `{ statusCode, message: "ingestion started", sumId, link, jobId, expiresAt }`, 400 "type must be text or pdf", PDF to `emrpdf-rh`, `activeLinks` row, `llm-summary` + `sum-id` on the item, email to patient and caregiver. Live on Bedrock, `discharge-summaries` and `emrpdf-rh` (created by `npm run setup-s3 -- --bucket emrpdf-rh`).
- [x] B4 `GET /llm-sumary?sum-id=` (and `/llm-summary`, `sum_id`): 200, 400, 404, 425, 410 at read time.
- [x] B5 `GET /translation?lang=&sum_id=`: cache-first on `translations[lang]`, agent on a miss given the `llm-summary`, result saved; live Mandarin on Bedrock.
- [x] B6 The purge refuses a `DEMO_NOW`-shifted run against DynamoDB or S3 (`DEMO_PURGE_ON_AWS=yes` to override on a throwaway account).
- [x] B7 Ingest as the tasks doc describes it: `pdfToText` runs before the 202 and the text (pasted or extracted) is saved on the DynamoDB item as `raw-text`; the background job is the LLM call, saving `llm-summary` + `sum-id`, and the emails. Translation is out of ingestion entirely (no `language` on `POST /ingest`, no `language` column on `activeLinks`, no `translations` or `language` attribute written at ingest); it exists only as `GET /translation` on demand, and `POST /synthesize` when a request names a language.
- [x] B8 The read routes work from the DynamoDB item alone: `GET /llm-sumary`, `GET /translation` and the aliases no longer require an `activeLinks` row (found when a hand-written entry in the real table answered 404). `npm run sample-entry` writes, resets or deletes one fake sample entry (`sampledischargesummary`) for trying them.
- [x] B9 Swagger docs from the current `openapi.yaml`: `npm run docs` builds the standalone `docs/swagger.html` (`scripts/swagger-docs.ts`), and `test/swagger-docs.test.ts` fails when the committed page differs from what the spec builds. The live `/docs` and `/openapi.json` read the same file.
- [x] B10 `GET /patients` takes no parameters: the `q` search filter, which the tasks doc does not ask for, is removed from the route, repository, OpenAPI, README and Swagger page, and a query string is ignored.

## Open (for the team)

- [ ] O1 Run `npm run check-sql` from the EC2 host that reaches RDS on 3306 and confirm the migrations on MariaDB (not reachable from the build container).
- [ ] O2 Deploy `src/audit/streamHandler.ts` on the table's stream (OLD_IMAGE) and `src/audit/s3EventHandler.ts` on the bucket's lifecycle events, with `AUDIT_SINK` set.
- [ ] O3 Enable `SPEECH_PROVIDER=transcribe` on the EC2 box and dictate one clip end to end.
- [ ] O4 Person C: iterate `src/pipeline/prompts.ts`; `POST /synthesize { linkId }` re-runs a stored summary (`linkId` = the sumId) after each change.
- [ ] O5 Front end: render `GET /p/:token` and `?language=` from `availableLanguages`; the email link is `${PATIENT_APP_URL}/s/<sumId>`.
