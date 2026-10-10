# DischargeAI backend: design (Kiro design doc)

## Architecture

```
 Provider app (teammates, Vite/React)             Patient phone (teammates)
          |  x-provider-key                                 |  link id only
          v                                                 v
 +------------------------------------------------------------------------+
 |  Express 5 + zod  (backend/src/app.ts)                                 |
 |  /patients  /ingest  /jobs/:id  /audit  /admin/*   /summary  /translate |
 |  /languages  /checklist/complete  /health  /docs  /openapi.json        |
 +-----------+-----------------------+---------------------+--------------+
             |                       |                     |
   +---------v--------+   +----------v-----------+   +-----v-------------------+
   | SQL (better-     |   | Pipeline (p-queue,   |   | DocumentStore           |
   | sqlite3 default, |   | persisted in `jobs`) |   |  LocalDocumentStore     |
   | pg via           |   |  extract (pdf-parse) |   |   (SQLite `documents`)  |
   | DATABASE_URL)    |   |  transcribe (agent)  |   |  DynamoDocumentStore    |
   |  patients        |   |  simplify (agent)    |   |   (lib-dynamodb, TTL on |
   |  links (enc_key) |   |  fidelity check      |   |    expiresAt)           |
   |  jobs            |   |  encrypt + store     |   +-------------------------+
   |  audit_log       |   |  email (nodemailer)  |
   |  checklist_state |   |  audit               |   +-------------------------+
   |  documents(local)|   +----------+-----------+   | Agents (src/agents)     |
   +------------------+              |               |  SimplifierAgent        |
                                     |               |   bedrock | anthropic | |
   +------------------+              |               |   offline               |
   | Clock + Purge    |<-------------+               |  TranslatorAgent        |
   |  app clock,      |                              |   bedrock | anthropic | |
   |  DEMO_MODE       |                              |   offline               |
   |  advance, purge  |                              |  TranscriberAgent       |
   |  interval        |                              |   aws (Transcribe Med)  |
   +------------------+                              |   | offline             |
                                                     +-------------------------+
   Email transports: console (default) | smtp | ses (@aws-sdk/client-sesv2)
   Optional queue:   EMAIL_QUEUE=sqs -> scripts/email-worker.ts (also Lambda handler)
```

## Module layout (`backend/`)

```
backend/
  package.json            type: module, scripts: dev, start, test, demo, seed, build, create-table
  tsconfig.json           ES2022, NodeNext, strict
  openapi.yaml            served at /docs
  docker-compose.yml      amazon/dynamodb-local on :8000
  .env.example            placeholders only
  .gitignore              .env, data/, node_modules, *.db, coverage
  src/
    index.ts              boot: migrate, seed, start purge timer, listen
    app.ts                buildApp(deps): express app with routes mounted
    config.ts             zod-validated env -> Config
    logger.ts             pino with redaction; no PHI
    clock.ts              Clock { now(): Date; advanceDays(n) } (DEMO_MODE only)
    db/
      index.ts            openDb(config) -> better-sqlite3 or pg adapter
      migrate.ts          runs migrations/*.sql in order, records in schema_migrations
      migrations/0001_init.sql
      repos/patients.ts, links.ts, jobs.ts, audit.ts, checklist.ts
    crypto/
      linkId.ts           randomBytes(16) -> base64url; sha256 hash
      envelope.ts         aes-256-gcm encrypt/decrypt with per-link key; keyVersion
    docstore/
      types.ts            DocumentStore interface + DocItem
      local.ts            LocalDocumentStore (SQLite)
      dynamo.ts           DynamoDocumentStore (lib-dynamodb)
      index.ts            factory by DOC_STORE
    extract/
      pdf.ts              pdf-parse PDFParse.getText, fallback pdfjs-dist legacy
      text.ts             normalize whitespace, strip page markers
    agents/
      types.ts            SimplifiedSummary zod schema + TS types, TranslatedSummary
      simplifier.ts       SimplifierAgent interface + factory
      translator.ts       TranslatorAgent interface + factory
      transcriber.ts      TranscriberAgent interface + factory
      bedrock/converse.ts shared Converse tool-JSON helper (schema -> toolConfig -> toolUse.input -> zod)
      bedrock/simplifier.ts, bedrock/translator.ts
      anthropic/simplifier.ts, anthropic/translator.ts   (@anthropic-ai/sdk, output_config json_schema)
      offline/simplifier.ts, offline/translator.ts, offline/transcriber.ts, offline/fixtures.ts
      aws/transcriber.ts  Transcribe Medical: S3 put -> StartMedicalTranscriptionJob -> poll -> fetch transcript JSON
      prompts/simplify.ts, prompts/translate.ts
    verify/
      fidelity.ts         medication name + numeric dose presence check, unit normalization
      backtranslate.ts    diff numbers and drug names between original and back-translation
      readability.ts      text-readability fleschKincaidGrade on summary (reported, not enforced)
    pipeline/
      queue.ts            p-queue concurrency 1, resumes `jobs` not in a terminal stage at boot
      ingestJob.ts        the stage machine
      purge.ts            purge job (interval + on demand)
    email/
      mailer.ts           nodemailer transport factory: console | smtp | ses
      queue.ts            SQS producer when EMAIL_QUEUE=sqs
      templates.ts        plain-text message: link + expiry only
    routes/
      health.ts patients.ts ingest.ts jobs.ts summary.ts translate.ts languages.ts checklist.ts audit.ts admin.ts docs.ts
    middleware/
      providerAuth.ts     x-provider-key check (timing-safe compare)
      errors.ts           zod -> 400, AppError -> status, else 500 (Express 5 async-aware)
      upload.ts           multer memoryStorage, 15 MB, fields file|audio
  fixtures/
    discharge-summaries/example-1-chf.txt ... example-5-endocarditis.txt
    discharge-summaries/example-1-chf.pdf  (generated from the txt for the PDF test)
    offline/simplified/example-1.json ... example-5.json
    offline/translations/example-1.es.json
    offline/transcripts/dictation-1.json
    live-samples/example-1-chf.bedrock.<modelId>.<date>.json
    patients.seed.json
  scripts/
    demo.sh  seed.ts  create-dynamo-table.ts  email-worker.ts  live-ingest.ts
  test/
    patients.test.ts ingest-text.test.ts ingest-pdf.test.ts translate-cache.test.ts expiry-purge.test.ts
    crypto.test.ts fidelity.test.ts auth.test.ts checklist.test.ts
  docs/
    spec.md design.md tasks.md research.md
```

## Data model

SQL (SQLite file `backend/data/app.db` by default; Postgres via `DATABASE_URL` with the same DDL using portable types):

- `patients(id TEXT PK, first_name, last_name, date_of_birth, zip_code, email, phone, active_link_id TEXT NULL, active_link_expires_at TEXT NULL, created_at TEXT)`. `active_link_id` stores the raw id only because the provider UI must render the link; it is cleared at purge.
- `links(link_id_hash TEXT PK, patient_id TEXT FK, status TEXT CHECK(pending|ready|needs_review|expired|purged), created_at TEXT, expires_at TEXT, key_version INTEGER, enc_key BLOB NULL, last_viewed_at TEXT NULL, language TEXT NULL, caregiver_email TEXT NULL, caregiver_approved INTEGER)`. `expires_at = created_at + 30 days` computed in code from the app clock, not by SQL now().
- `jobs(id TEXT PK, link_id_hash TEXT FK, stage TEXT, error TEXT NULL, warnings TEXT (JSON), created_at, updated_at)`.
- `audit_log(id INTEGER PK, event TEXT, link_id_hash TEXT NULL, actor TEXT CHECK(provider|patient|system), at TEXT, details TEXT (JSON, no PHI))`.
- `checklist_state(link_id_hash TEXT, item_id TEXT, completed INTEGER, updated_at TEXT, PK(link_id_hash, item_id))`.
- `documents(pk TEXT, sk TEXT, ciphertext BLOB, iv BLOB, tag BLOB, key_version INTEGER, expires_at INTEGER, created_at TEXT, PK(pk, sk))` used only by `LocalDocumentStore`.
- `schema_migrations(name TEXT PK, applied_at TEXT)`.

Document store items (both implementations):

```
{ pk: "link#<linkId>", sk: "raw" | "simplified" | "translation#<langCode>",
  ciphertext: Buffer, iv: Buffer(12), tag: Buffer(16), keyVersion: 1,
  expiresAt: <epoch seconds>, createdAt: ISO }
```

DynamoDB: table `DYNAMO_TABLE` with `pk` (S, HASH) and `sk` (S, RANGE), `BillingMode: PAY_PER_REQUEST`, TTL enabled on `expiresAt` (Number, epoch seconds). Verified against DynamoDB Local 1.25.1 in this container on 2026-10-10 (see research.md section 4.2).

The `pk` uses the raw link id, not the hash, because the document store is only ever addressed by a caller who already holds the raw id, and the ciphertext is useless without `links.enc_key`. SQL stores only the hash so a database dump does not reveal usable links.

## Crypto design

- Link id: 16 random bytes, base64url (22 chars). Hash: sha256 hex. Lookup by hash. The raw id appears only in the 202 response, the email and `patients.active_link_id`.
- Per-link data key: 32 random bytes stored in `links.enc_key`. Each payload: AES-256-GCM, fresh 12-byte IV, 16-byte auth tag, AAD = `pk|sk|keyVersion`. Verified with Node `crypto.createCipheriv/createDecipheriv` in the smoke test.
- Purge sets `enc_key = NULL` first (crypto-shredding), then deletes document items. If the delete lags or DynamoDB TTL lags (AWS states deletion happens "typically within a few days" of expiry), the ciphertext is already unreadable. Read paths also compare `expires_at` with the app clock and return 410 before touching the store.
- `KEY_VERSION` env allows a future KMS-wrapped key without changing the item shape.

## Pipeline (stage machine)

```
received -> extracting (pdf) | transcribing (audio) -> simplifying -> stored -> emailing -> done
                                                       \-> needs_review (fidelity warnings; still stored and emailed, flagged)
   any stage --error--> failed
```

- `p-queue` with concurrency 1 (ESM-only package; the project is ESM). On boot, any job whose stage is not `done|failed|needs_review` is re-enqueued.
- Fidelity check (deterministic, after the LLM): for each medication in `new|continue|stop`, the name must appear in the source (case-insensitive; hyphen and slash tolerant); each numeric dose token (`40 mg`, `875/125 mg`, `0.4 mg`) must appear after unit normalization (`mg`, `milligram(s)`; `mcg`, `ug`, `microgram(s)`; `g`, `gram(s)`; whitespace-insensitive). Any miss -> `warnings.push({ code: "med_not_in_source" | "dose_not_in_source", name, dose })` and job stage `needs_review`. Back-translation check for translations works the same way on numbers and drug names.
- Readability: `text-readability` `fleschKincaidGrade(summary)` stored in `warnings` as informational when above 7 (reported, never blocks).

## Agents

- `SimplifierAgent.simplify({ text, language? })` -> `SimplifiedSummary`. Bedrock implementation: `ConverseCommand` with `system` (never invent medications or doses; keep every drug name, dose and frequency verbatim; 5th-grade level; call `emit_summary` once), one user message holding the source text, `toolConfig.tools[0].toolSpec.inputSchema.json = z.toJSONSchema(SimplifiedSummary)` (zod 4 built-in), `toolChoice: { tool: { name: "emit_summary" } }` (forced; verified live on both profiles), `inferenceConfig: { maxTokens: 4096, temperature: 0 }`. Read `output.message.content.find(c => c.toolUse).toolUse.input`, validate with zod, retry once on validation failure with the zod issues appended to the user message.
- `TranslatorAgent.translate({ summary, language })` -> `TranslatedSummary` (same shape plus `language`, `backTranslationWarnings`). Bedrock implementation: one call to translate field by field with medication `name|dose|howOften` passed through unchanged, then one call back to English, then `verify/backtranslate.ts`.
- `TranscriberAgent.transcribe({ audio: Buffer, mimeType })` -> `{ text, provider, jobName? }`. AWS implementation: `PutObjectCommand` to `TRANSCRIBE_BUCKET`, `StartMedicalTranscriptionJobCommand` (`LanguageCode: "en-US"`, `Specialty: "PRIMARYCARE"`, `Type: "DICTATION"`, `Media.MediaFileUri: s3://bucket/key`, `OutputBucketName`), poll `GetMedicalTranscriptionJobCommand` until `COMPLETED|FAILED`, `GetObjectCommand` the transcript JSON and read `results.transcripts[0].transcript`. Marked "needs S3 bucket" in README. Offline implementation returns `fixtures/offline/transcripts/dictation-1.json`.
- Anthropic direct implementation (`LLM_PROVIDER=anthropic`) uses `@anthropic-ai/sdk` `messages.create` with `output_config: { format: { type: "json_schema", schema } }` and JSON.parse of the first text block; untested here (no key) and listed under "needs a key".

## Email

- `nodemailer.createTransport` by `EMAIL_TRANSPORT`: `console` -> `{ jsonTransport: true }` then log the parsed message and the link; `smtp` -> `SMTP_URL`; `ses` -> `{ SES: { sesClient: new SESv2Client({ region }), SendEmailCommand } }` from `@aws-sdk/client-sesv2` (nodemailer 10 requires the v2 client; verified by constructing the transport).
- `EMAIL_QUEUE=sqs`: `SendMessageCommand({ QueueUrl, MessageBody: JSON.stringify(msg) })`; worker: `ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 20 })` -> send -> `DeleteMessageCommand({ QueueUrl, ReceiptHandle })`. Exported `handler(event)` iterates `event.Records[].body` for Lambda.

## Clock, expiry and purge

- `Clock` is injected everywhere a timestamp is produced or compared. `DEMO_MODE=true` enables `POST /admin/clock/advance { days }` which adds an offset; `GET /health` reports `clock.now` and `clock.offsetDays`.
- `purge.run()` selects links with `expires_at <= now` and status not `purged`: null the key, delete `pk=link#<id>` items (Query by pk then DeleteCommand each; local: `DELETE WHERE pk=?`), status `purged`, clear `patients.active_link_id`, audit `link.purged` + `key.destroyed`. Interval `PURGE_INTERVAL_MS` (default 60000) with `unref()` so tests exit.

## Security and logging

- Provider key compare with `crypto.timingSafeEqual`. Patient endpoints rate-limited lightly (in-memory token bucket per IP) to slow link guessing; 128-bit ids make guessing infeasible anyway.
- pino redact paths: `req.headers["x-provider-key"]`, `req.headers.authorization`, `email`, `*.email`, `text`, `*.text`, `summary`, `*.summary` (pino `*` matches one level, so both forms are listed). Request logging via `pino-http` with `autoLogging.ignore` for `/health`.
- multer `memoryStorage`, `limits: { fileSize: 15 * 1024 * 1024, files: 1 }`; PDF magic-byte check (`%PDF-`) before parsing.

## OpenAPI

`openapi.yaml` is hand-written (3.0.3), parsed with `yaml` at boot and served by `swagger-ui-express` at `/docs` (verified on Express 5). The zod schema for `SimplifiedSummary` is exported as JSON Schema into `components.schemas` by a `scripts/sync-openapi.ts` step so the two never drift.

## Env

```
PORT=4000  PATIENT_APP_URL=http://localhost:5173  PROVIDER_API_KEY=dev-provider-key
DATABASE_URL=            (empty -> SQLite backend/data/app.db)
DOC_STORE=local|dynamo   DYNAMO_TABLE=dischargeai-docs  DYNAMO_ENDPOINT=http://localhost:8000
LLM_PROVIDER=offline|bedrock|anthropic   BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6  AWS_REGION=us-west-2
ANTHROPIC_API_KEY=       ANTHROPIC_MODEL=claude-opus-5-5
TRANSCRIBE_PROVIDER=offline|aws   TRANSCRIBE_BUCKET=
EMAIL_TRANSPORT=console|smtp|ses  EMAIL_FROM=noreply@example.test  SMTP_URL=  EMAIL_QUEUE=none|sqs  SQS_QUEUE_URL=
DEMO_MODE=true  PURGE_INTERVAL_MS=60000  LOG_LEVEL=info  KEY_VERSION=1
```

## IAM permissions (README table)

`bedrock:InvokeModel` on the inference profile and the underlying foundation models; `dynamodb:CreateTable, UpdateTimeToLive, DescribeTimeToLive, PutItem, GetItem, Query, DeleteItem` on the table; `ses:SendEmail`; `sqs:SendMessage, ReceiveMessage, DeleteMessage`; `transcribe:StartMedicalTranscriptionJob, GetMedicalTranscriptionJob`; `s3:PutObject, GetObject` on the transcribe bucket.

## Decisions and alternatives considered

- Express 5 over Fastify: async errors propagate to the error middleware natively (verified), multer and swagger-ui-express work unchanged, teammates know it.
- Thin repository layer over Drizzle: fewer moving parts for two SQL dialects; migrations are plain SQL files.
- pdf-parse v2 (`PDFParse` class) over v1 API: the installed 2.4.5 has a different API from the widely copied v1 snippet; the fallback is pdfjs-dist legacy build, which also parsed the hackathon PDF.
- No `dosis` package for dose parsing: the published 0.1.0 is broken (missing `dist/parser`); a 40-line regex normalizer in `verify/fidelity.ts` covers mg, mcg, g, mL, units and ratio doses.
- No `@types/nodemailer`: nodemailer 10 ships its own types and the README says the DefinitelyTyped package conflicts.
- DynamoDB Local: the Docker daemon is not available in this container, but the jar downloads from `s3.us-west-2.amazonaws.com/dynamodb-local` and runs on the installed Java 21, so `scripts/dynamodb-local.sh` offers that path next to `docker compose up`.
