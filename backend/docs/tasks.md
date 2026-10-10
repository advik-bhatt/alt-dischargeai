# DischargeAI backend: task list (Kiro tasks)

Checked items are done. Research stage completed the "R" items; the build stage works the "B" items top to bottom. Each B item names the files it creates.

## R. Research (done 2026-10-10)

- [x] R1 Read the challenge brief, Advik's API note, the advisors' note, the five example summaries and the sponsor facts.
- [x] R2 Verify the stack installs in this container (Node 22.22, npm 10.9): Express 5.3, zod 4.6, pino 10.4, better-sqlite3 13.0 (native build OK), multer 2.4, nodemailer 10.1, pdf-parse 2.4.5, pdfjs-dist 6.4, p-queue 9.3, swagger-ui-express 5.0, yaml 2.9, pg 8.23, AWS SDK v3 3.1149 (bedrock-runtime, dynamodb, lib-dynamodb, sesv2, sqs, transcribe, s3), text-readability 1.1, vitest 5.0, supertest 7.3, tsx 4.23, typescript 7.0.
- [x] R3 Smoke-test Express 5 + multer + zod + p-queue + better-sqlite3 + AES-256-GCM + vitest + supertest + tsx + tsc together in ESM mode (4/4 tests pass).
- [x] R4 Parse the hackathon discharge PDF with pdf-parse v2 (14 pages, 21,820 chars) and with the pdfjs-dist legacy fallback.
- [x] R5 Run live Bedrock Converse with tool-based JSON on `us.anthropic.claude-sonnet-4-6` (forced toolChoice) and `us.anthropic.claude-haiku-4-5-20251001-v1:0` (auto toolChoice); record shapes in research.md.
- [x] R6 Run DynamoDB Local (jar, Java 21) and exercise CreateTable + UpdateTimeToLive + Put/Get/Query/Delete through lib-dynamodb.
- [x] R7 Verify nodemailer 10 transports construct: jsonTransport (console), streamTransport, SES (`@aws-sdk/client-sesv2`), SMTP; swagger-ui-express serves on Express 5.
- [x] R8 Record exact request/response shapes for Converse, lib-dynamodb, SES v2, SQS, Transcribe Medical, S3, nodemailer, pdf-parse in docs/research.md.
- [x] R9 Write docs/spec.md, docs/design.md, docs/tasks.md, docs/research.md.

## B. Build

### B1 Project skeleton
- [ ] `backend/package.json` (type module; scripts: `dev` tsx watch, `start` tsx src/index.ts, `test` vitest run, `demo` sh scripts/demo.sh, `seed`, `create-table`, `typecheck`), `backend/tsconfig.json` (ES2022, NodeNext, strict), `backend/.gitignore`, `backend/.env.example`, `backend/vitest.config.ts`.
- [ ] `src/config.ts` (zod env), `src/logger.ts` (pino + redaction), `src/clock.ts`, `src/middleware/errors.ts`, `src/middleware/providerAuth.ts`, `src/middleware/upload.ts`, `src/routes/health.ts`, `src/app.ts`, `src/index.ts`.
- [ ] Acceptance: `npm run dev` serves `GET /health` -> `{ ok: true, clock, providers }`.

### B2 SQL layer and migrations
- [ ] `src/db/index.ts` (better-sqlite3; pg adapter when DATABASE_URL), `src/db/migrate.ts`, `src/db/migrations/0001_init.sql` (patients, links, jobs, audit_log, checklist_state, documents, schema_migrations).
- [ ] `src/db/repos/{patients,links,jobs,audit,checklist}.ts`, `fixtures/patients.seed.json` (6 synthetic patients), `scripts/seed.ts` (idempotent, also runs at boot when table empty).
- [ ] Acceptance: `test/patients.test.ts` passes (list, search, create, 400, 401).

### B3 Crypto and document store
- [ ] `src/crypto/linkId.ts`, `src/crypto/envelope.ts` (AES-256-GCM, AAD pk|sk|keyVersion).
- [ ] `src/docstore/types.ts`, `src/docstore/local.ts`, `src/docstore/dynamo.ts`, `src/docstore/index.ts`; `scripts/create-dynamo-table.ts`; `docker-compose.yml`; `scripts/dynamodb-local.sh` (jar path for machines without Docker).
- [ ] Acceptance: `test/crypto.test.ts` (round trip; unreadable after key destruction; wrong AAD fails). Manual: `DOC_STORE=dynamo DYNAMO_ENDPOINT=http://localhost:8000 npm run create-table` then an ingest lands three items with `expiresAt`.

### B4 Fixtures
- [ ] `fixtures/discharge-summaries/example-{1..5}-*.txt` copied from the hackathon examples; `fixtures/discharge-summaries/example-1-chf.pdf` generated with a tiny script (pdfkit or a pre-built PDF) for the PDF test.
- [ ] `fixtures/offline/simplified/example-{1..5}.json` hand-curated to the SimplifiedSummary shape, every drug/dose copied from the source; `fixtures/offline/translations/example-1.es.json`; `fixtures/offline/transcripts/dictation-1.json`.

### B5 Agents: interfaces, offline providers, Bedrock providers
- [ ] `src/agents/types.ts` (zod SimplifiedSummary, TranslatedSummary; `z.toJSONSchema` export), `src/agents/simplifier.ts`, `src/agents/translator.ts`, `src/agents/transcriber.ts` (interfaces + factories).
- [ ] `src/agents/offline/{fixtures,simplifier,translator,transcriber}.ts` (fingerprint match on the five examples; rule-based extraction fallback: medication lines under New/Continue/Stopped headings, return precautions bullets, follow-up lines).
- [ ] `src/agents/prompts/{simplify,translate}.ts`, `src/agents/bedrock/converse.ts` (schema -> toolConfig; toolUse.input -> zod; one retry), `src/agents/bedrock/{simplifier,translator}.ts`.
- [ ] `src/agents/anthropic/{simplifier,translator}.ts` (`@anthropic-ai/sdk`, output_config json_schema; marked needs a key).
- [ ] `src/agents/aws/transcriber.ts` (S3 put, StartMedicalTranscriptionJob, poll, fetch transcript; marked needs S3 bucket).
- [ ] Acceptance: offline simplifier returns the Example 1 fixture; Bedrock simplifier unit test is skipped without `LLM_PROVIDER=bedrock`.

### B6 Verification
- [ ] `src/verify/fidelity.ts` (name presence; numeric dose normalization mg/mcg/g/mL/units, ratio doses like 875/125 mg), `src/verify/backtranslate.ts`, `src/verify/readability.ts`.
- [ ] Acceptance: `test/fidelity.test.ts` catches an injected wrong dose (`Furosemide 80 mg` against Example 1) and passes the correct fixture with zero warnings.

### B7 Extraction and ingest pipeline
- [ ] `src/extract/pdf.ts` (PDFParse.getText; fallback pdfjs-dist legacy getDocument/getTextContent), `src/extract/text.ts`.
- [ ] `src/pipeline/queue.ts`, `src/pipeline/ingestJob.ts` (stage machine, persisted; email + audit at the end), `src/routes/ingest.ts`, `src/routes/jobs.ts`.
- [ ] Acceptance: `test/ingest-text.test.ts` (202 -> poll job -> done -> summary ready; empty input 400), `test/ingest-pdf.test.ts` (fixture PDF -> done).

### B8 Patient endpoints
- [ ] `src/routes/summary.ts` (404/410/425; expiry at read time; daysLeft; checklistState; warnings), `src/routes/translate.ts` (cache -> agent -> store), `src/routes/languages.ts`, `src/routes/checklist.ts`.
- [ ] Acceptance: `test/translate-cache.test.ts` (second call `fromCache: true`, agent called once), `test/checklist.test.ts`.

### B9 Email
- [ ] `src/email/templates.ts`, `src/email/mailer.ts` (console | smtp | ses), `src/email/queue.ts` (sqs), `scripts/email-worker.ts` (poll loop + Lambda `handler`).
- [ ] Acceptance: console transport prints `Your discharge summary is ready: <link> (expires <date>)` during the ingest test; caregiver email only when `caregiverApproved=true`.

### B10 Clock, purge, admin, audit
- [ ] `src/pipeline/purge.ts`, `src/routes/admin.ts` (DEMO_MODE guard), `src/routes/audit.ts`.
- [ ] Acceptance: `test/expiry-purge.test.ts` (advance 30 days -> 410; purge -> `enc_key` null, zero doc items, status purged, `patients.active_link_id` null, audit has `key.destroyed`), `test/auth.test.ts`.

### B11 OpenAPI and docs route
- [ ] `backend/openapi.yaml`, `scripts/sync-openapi.ts`, `src/routes/docs.ts` (`/docs`, `/openapi.json`).

### B12 Live Bedrock run and live sample
- [ ] `scripts/live-ingest.ts`: with `LLM_PROVIDER=bedrock` (credentials from the shell env only) ingest Example 1 and write `fixtures/live-samples/example-1-chf.bedrock.<modelId>.<date>.json` (output JSON + fidelity result + usage; never credentials). Record "verified live on Bedrock" with model id and date in README.

### B13 Demo script and README
- [ ] `scripts/demo.sh` (curl narrative with the offline providers: ingest Example 1 -> email printed -> /summary -> /translate?language=Spanish -> /admin/clock/advance 30 -> 410 -> /admin/purge -> /audit).
- [ ] `backend/README.md` (what it is; architecture; run in 3 commands; env table; endpoint table with curl; team agent contract; demo narrative; needs-a-key table; what stays under human control; sponsor APIs; IAM table; test counts).
- [ ] One pointer paragraph in the repo-root README.md.

### B14 Final verification
- [ ] `npm test` passes offline (record passing/total), `npm run typecheck` clean, server boots with defaults, `scripts/demo.sh` completes against the running server, `DOC_STORE=dynamo` path exercised once against DynamoDB Local.
- [ ] Commit in atomic steps on `backend`; `git push -u origin backend` after each milestone.
