# DischargeAI backend (branch `backend`)

Discharge summaries in (pasted text, a PDF, or dictated audio), a plain-language patient link out, and every piece of data self-destructs 30 days after it was created. Node 22, TypeScript, Express 5. The patient-facing JSON is a fixed contract per language; Claude on Amazon Bedrock does the simplifying and translating; a deterministic safety check verifies every medication, dose and frequency before anything reaches a patient.

## Precedence

Advik's Granola note is the source of truth: everything in it ships here as described (SQL patient table, `GET /patients`, `POST /ingest` with a 202 and asynchronous PDF-to-text, LLM simplification, DynamoDB storage and the patient email, `GET /summary`, `GET /translate` cache-first in DynamoDB). The team architecture diagram fills in whatever the note is silent on (`POST /synthesize`, `GET /p/:token`, the fixed per-language JSON, S3 audio with the 30-day lifecycle, deletion receipts in an audit log, light provider auth, unguessable hashed tokens, Transcribe Medical, safety checks). Where the two conflict, the note wins: translation is on demand with a cache, and producing the provider-picked language during synthesis is an addition, not a contradiction. The real AWS resources override the names in both documents: the table is `discharge-summaries`, not `discharge_records`. Nothing beyond the note and the diagram is a public surface on this branch.

## Run it

```sh
cd backend && npm install && npm run dev
```

That is the whole setup. With nothing configured the backend runs fully local: SQLite, the SQL twin of the document store, a local audio folder, offline AI providers driven by fixtures, and the console email transport. Six synthetic patients are seeded at boot. Docs are at `http://localhost:4000/docs`.

With AWS credentials in the shell (or an instance role on the team's EC2 box) the backend reads the team secret at boot and switches to MariaDB on RDS, DynamoDB and S3 by itself. See "Team infrastructure".

```sh
npm test            # 84 tests, 16 files, offline, no keys
npm run typecheck
npm run demo        # the narrative below, against the running server
```

## The demo (what the judge sees)

`npm run demo` runs `scripts/demo.sh` against the server started with `npm run dev`:

1. `GET /health` shows the clock, where the configuration came from, and the active providers.
2. `GET /patients` picks patient 1.
3. `POST /ingest` with Example 1 (the CHF discharge summary) and `language=Spanish` answers `202 { status: "ingestion started", linkId, link, expiresAt }` at once.
4. `GET /jobs/:id` goes `received -> simplifying -> stored -> emailing -> done`; the server terminal prints the email: "Your discharge summary is ready at this link: ...". The safety check reports 11 medications in the source, 11 in the output, nothing dropped, nothing unsupported.
5. `GET /p/:token` returns the fixed JSON in English with `daysLeft: 30`, `expiresAt`, `availableLanguages: ["en", "es"]`.
6. `GET /p/:token?language=es` returns Spanish from the document store (`fromCache: true`): it was produced at ingest because the provider picked it.
7. `GET /translate?link=...&language=zh` runs the translation agent once (`fromCache: false`), the second call is served from the store (`fromCache: true`). Medication names and doses are identical in every language.
8. `POST /synthesize { text, language: "ar" }` runs lane 3 directly and returns the JSON per language plus the safety result, storing nothing.
9. Day 30: `DEMO_NOW=<31 days ahead> npm run sweep` runs the purge against the same stores. The data key is destroyed, the four document-store items are deleted, one deletion receipt is written per item.
10. `GET /p/:token` and `GET /translate` answer `410 link_purged`.
11. `npm run show-audit -- --receipts` and `npm run show-audit -- --link <linkId>` print the receipts and the link's audit trail; no PHI appears in either.

Run on 2026-10-10 in the build container with the offline providers: exit 0, every step as above.

## Public surface

Provider endpoints need `x-provider-key: <PROVIDER_API_KEY>`. Patient endpoints need no header; the unguessable 128-bit link id is the credential.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/health` | anyone | clock, configuration source, providers, audio store and fallback reason |
| GET | `/patients[?q=]` | provider | the patient list (note) |
| GET | `/patients/:id` | provider | one patient, with the active link once generated |
| POST | `/patients` | provider | create a patient (seeding) |
| POST | `/ingest` | provider | multipart `patientId` + one of `text`, `file` (PDF), `audio`, plus `language`; `202 "ingestion started"` (note; audio from the diagram) |
| GET | `/jobs/:jobId` | provider | follow the 202: stage, safety result, run metadata |
| POST | `/synthesize` | provider | `{ text, language?, languages? }` returns the JSON per language; `{ linkId }` re-runs the pipeline over the stored raw text and stores the result (diagram) |
| GET | `/summary?link=[&language=]` | patient | the LLM response from the document store, expiry upfront (note) |
| GET | `/translate?link=&language=` | patient | cache-first in the document store, translation agent on a miss (note) |
| GET | `/p/:token[?language=]` | patient | the same handler with the token in the path (diagram) |
| GET | `/docs`, `/openapi.json` | anyone | OpenAPI 3 |

Patient responses are the fixed JSON plus `{ expiresAt, daysLeft, availableLanguages, fromCache }`. Status codes: 400 malformed link or language, 404 unknown link, 410 expired or purged, 425 still processing, 423 held for clinician review (safety checks failed; no email was sent), 422 a translation that changed a name, dose or number (refused, not cached), 502 the translation agent is unavailable.

The fixed JSON (`contracts/ai-output.schema.json`, `contracts/ai-output.ts`), exactly these keys per language:

```
{ language, steps: [{ id, text }], medications: [{ name, dose, howOften, status: new|continue|stop, why }],
  followUps: [{ who, when, why }], warnings: [{ text, tier?: call911|er|clinic }] }
```

Safety-check results are stored separately and returned by `POST /synthesize` and `GET /jobs/:id`, never inside the per-language object.

## Lane by lane: diagram element to file

| Diagram element | Where it lives |
| --- | --- |
| Provider front end, light provider auth | `src/middleware/providerAuth.ts` (`x-provider-key`, constant-time compare) |
| `POST /ingest` audio/text + language, store audio, 202 | `src/routes/ingest.ts`, `src/data/audio.ts` (S3 `emraudio-rh` or local twin), `src/pipeline/ingestJob.ts` |
| Link service, unguessable hashed tokens | `src/crypto/linkId.ts` (128 random bits, base64url; only sha256 at rest), `src/db/repos/links.ts` |
| SQL patient table, active link | `src/db/migrations/0001_init.sql`, `src/db/repos/patients.ts`, MariaDB via `src/db/index.ts` (`MySqlDb`), SQLite locally |
| Speech to text (Transcribe Medical) | `src/pipeline/speechToText.ts`, `src/pipeline/transcribe/medical.ts`, offline fixture `fixtures/offline/transcripts/dictation-1.json` |
| Jargon to plain language, Bedrock Claude at grade 5 | `src/pipeline/simplify.ts`, `src/pipeline/bedrock/{converse,simplify}.ts`, `src/pipeline/prompts.ts`, offline `src/pipeline/offline/{fixtures,rules}.ts` |
| Safety checks (never drop meds, doses, times) | `src/pipeline/safetyChecks.ts` (deterministic, both directions, plus the translation check) |
| Translate (Spanish, Mandarin, Arabic, any BCP-47) | `src/pipeline/translate.ts`, `src/pipeline/bedrock/translate.ts`, fixtures `fixtures/offline/ai-output/example-1.{es,zh,ar}.json` |
| Pipeline composed (`runPipeline`) | `src/pipeline/runPipeline.ts`; `POST /synthesize` in `src/routes/synthesize.ts` |
| Fixed JSON per language | `src/contracts/aiOutput.ts`, published `contracts/ai-output.schema.json` and `contracts/ai-output.ts` (`npm run export-contract`) |
| DynamoDB `discharge-summaries`, TTL `expiresAt` | `src/docstore/dynamo.ts`, SQL twin `src/docstore/local.ts`, encryption `src/docstore/secure.ts` + `src/crypto/envelope.ts`, `scripts/setup-dynamo.ts` |
| `GET /p/:token`, `GET /summary`, `GET /translate` | `src/routes/patientLink.ts`, `src/routes/summary.ts`, `src/routes/translate.ts`, shared `src/routes/linkAccess.ts` |
| Email the patient (console, SMTP, SES, optional SQS + worker) | `src/email/{mailer,templates,queue}.ts`, `scripts/email-worker.ts` |
| Day 30 self-destruct: read-time expiry, purge, DynamoDB TTL, S3 lifecycle | `src/routes/linkAccess.ts` (410 at read time), `src/pipeline/purge.ts`, `scripts/sweep.ts`, `scripts/ensure-s3-lifecycle.ts` |
| Deletion receipts in the audit log | `src/audit/receipts.ts` (sql, file, console, dynamo sinks), `src/audit/streamHandler.ts` (DynamoDB Streams, TTL REMOVE events), `src/audit/s3EventHandler.ts` (lifecycle expirations), `scripts/show-audit.ts` |
| Configuration from the team secret | `src/secrets.ts`, `src/bootstrap.ts` |

## Team infrastructure

Region `us-west-2`, account `183815333909`. All of it is wired in; the backend reads the secret at boot and uses the real resources whenever AWS credentials resolve.

- Secrets Manager secret `hackhealth/secret`, ARN `arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q`. Keys: `dynamodb-table` (`discharge-summaries`), `dynamodb-table-pk` (`uid`), `mysql-host`, `mysql-port` (3306), `mysql-user` (`admin`), `mysql-password`, `mysql-db` (`dischargeai`, the database to use; the tables are created inside it). The password and the database name come only from the secret at runtime; they are never in a file, a log, a test or this README. `/health` reports which variables came from the secret, by name.
- RDS instance `patients`: MariaDB, `db.t4g.micro`, endpoint `patients.cleqcmkoulma.us-west-2.rds.amazonaws.com`, port 3306, user `admin`, IAM authentication enabled, security group open on 3306. The AWS console's connection steps:
  1. `curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` (`npm run fetch-rds-bundle` runs exactly this into `certs/`; a copy of the public bundle is committed, identical to the one on `feature/infra-setup`).
  2. `mysql -h patients.cleqcmkoulma.us-west-2.rds.amazonaws.com -P 3306 -u admin -p"$(aws secretsmanager get-secret-value --secret-id 'arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q' --query SecretString --output text | jq -r '.["mysql-password"]')" --ssl-verify-server-cert --ssl-ca=./global-bundle.pem` (the console's own snippet reads the RDS-managed master secret with `jq -r '.password'` instead; both work, the password is never pasted).
  The backend does the same over `mysql2`: `ssl: { ca: readFileSync(RDS_CA_BUNDLE), rejectUnauthorized: true }`, a connection pool, `CREATE DATABASE IF NOT EXISTS dischargeai`, then the migrations. Either let the secret drive it, or set `DATABASE_URL=mysql://admin:<password>@patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306/dischargeai`. `npm run check-sql` connects, migrates and prints the server version and table counts.
- DynamoDB table `discharge-summaries`: hash key `uid` (string), no sort key, TTL enabled on `expiresAt` (epoch seconds). Items per link: `<linkIdHash>#raw`, `<linkIdHash>#simplified`, `<linkIdHash>#translation#<lang>`, each with `pk`, `sk`, sealed `ciphertext/iv/tag`, `keyVersion`, `expiresAt`, `createdAt`. With a single hash key the per-link listing and the backstop sweep are filtered scans; fine at hackathon scale, a sort key or GSI is the production step. `npm run setup-dynamo` creates the table when missing and enables TTL, idempotently.
- S3 bucket `emraudio-rh`: audio clips under `<linkIdHash>.<ext>` with SSE-S3 (AES256). The bucket already carries the lifecycle rule `autodelete` (expire after 30 days, abort incomplete multipart uploads after 30 days); `npm run ensure-s3-lifecycle -- --check` verifies it and the non-check form adds a 30-day rule only when none exists. If the bucket is unreachable at boot the backend falls back to the local folder and says so in `/health` (`providers.audio.fallbackReason`).

IAM the backend needs: `secretsmanager:GetSecretValue` on the secret; `dynamodb:PutItem, GetItem, DeleteItem, Scan` on the table plus `DescribeTable, DescribeTimeToLive, UpdateTimeToLive, CreateTable` for the setup script; `bedrock:InvokeModel` on `us.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-haiku-4-5-20251001-v1:0`; `s3:PutObject, GetObject, DeleteObject, ListBucket` on `emraudio-rh` (plus `GetLifecycleConfiguration, PutLifecycleConfiguration` for the lifecycle script); `ses:SendEmail` when `EMAIL_TRANSPORT=ses`; `sqs:SendMessage` (and `ReceiveMessage, DeleteMessage` for the worker) when `EMAIL_QUEUE=sqs`; `transcribe:StartMedicalTranscriptionJob, GetMedicalTranscriptionJob` when `SPEECH_PROVIDER=transcribe`; the Streams handler needs `dynamodb:DescribeStream, GetRecords, GetShardIterator, ListStreams`.

### Verified live from the build container (2026-10-10, Workshop Studio role)

| Check | Result |
| --- | --- |
| Secrets Manager `GetSecretValue` | all seven keys read and applied (406 ms); recorded in `fixtures/live-samples/infra.2026-10-10.json` |
| DynamoDB `discharge-summaries` | ACTIVE, hash key `uid`, TTL ENABLED on `expiresAt`; probe item put 84 ms, get 65 ms, delete 71 ms, gone after delete; `npm run setup-dynamo` reports no change needed |
| S3 `emraudio-rh` | HeadBucket ok; probe object put with SSE AES256 107 ms, get 89 ms, delete 81 ms; lifecycle rule `autodelete` 30 days present |
| Bedrock Converse | `us.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-haiku-4-5-20251001-v1:0` both answer the tool-based JSON call |
| Full pipeline on Bedrock | Example 1 through `POST /ingest` with Spanish on `us.anthropic.claude-sonnet-4-6`: done, safety checks passed (11 source medications, nothing dropped or unsupported), Spanish translation check passed, Mandarin on demand produced and cached; 5,273 tokens, 31.8 s model time; `fixtures/live-samples/example-1-chf.bedrock.us.anthropic.claude-sonnet-4-6.2026-10-10.json` |

`npm run verify-infra -- --bedrock` reproduces the first four rows and deletes its probe items; `LLM_PROVIDER=bedrock npm run live-ingest` reproduces the last.

### Needs a key or not exercised live from the build container

| Item | State |
| --- | --- |
| MySQL/MariaDB on RDS over port 3306 | implemented from the mysql2 API (pool, TLS with the RDS bundle, portable migrations, dialect rewrites) and tested through the shared SQL layer on SQLite; port 3306 is not reachable from the build container, so it is not exercised live. Run `npm run check-sql` from the EC2 host |
| Amazon SES (`EMAIL_TRANSPORT=ses`), SMTP | transports construct; no sending identity here |
| SQS email queue and `scripts/email-worker.ts` | producer and worker written; no queue URL here |
| Amazon Transcribe Medical (`SPEECH_PROVIDER=transcribe`) | adapter reads the clip from the bucket by key and polls the job; not run here (the offline fixture transcript is used) |
| DynamoDB Streams and S3 event Lambda handlers | exported handlers with tests on sample events; not deployed |
| Direct Anthropic API (`LLM_PROVIDER=anthropic`) | client written; no `ANTHROPIC_API_KEY` here |

## Configuration

Copy `.env.example` to `.env`. Everything has a local default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST`, `LOG_LEVEL` | `4000`, `0.0.0.0`, `info` | server |
| `PATIENT_APP_URL` | `http://localhost:5173` | links look like `${PATIENT_APP_URL}/s/<linkId>` |
| `PROVIDER_API_KEY` | `dev-provider-key` | the `x-provider-key` value |
| `DEMO_NOW` | unset | pins the app clock to an ISO moment at boot (day-30 demos); never in production |
| `PURGE_INTERVAL_MS` | `60000` | purge timer; `0` disables it (`npm run sweep` runs it once) |
| `SECRETS_BOOTSTRAP`, `AWS_SECRET_ARN`, `AWS_REGION` | `auto`, the team ARN, `us-west-2` | read the secret at boot when credentials resolve; `off` never calls AWS |
| `DATABASE_URL` | unset | `sqlite:<file>` or `mysql://user:password@host:3306/db`; wins over everything |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_POOL_SIZE` | from the secret, `dischargeai`, `5` | MariaDB; used when `DATABASE_URL` is unset and a host is known |
| `DATABASE_FILE` | `data/app.db` | SQLite when nothing else is set |
| `RDS_CA_BUNDLE` | `certs/global-bundle.pem` | AWS connection step 1 |
| `DOC_STORE`, `DYNAMO_TABLE`, `DYNAMO_PK`, `DYNAMO_ENDPOINT` | `auto`, `discharge-summaries`, `uid`, unset | `auto` means DynamoDB when the secret resolved, else the SQL twin; set the endpoint for DynamoDB Local |
| `KEY_VERSION` | `1` | per-link data key version |
| `AUDIO_STORE`, `AUDIO_BUCKET`, `AUDIO_DIR` | `auto`, `emraudio-rh`, `data/audio` | `auto` means S3 when the secret resolved and the bucket answers, else the local folder |
| `AUDIT_SINK`, `AUDIT_FILE` | `sql`, `data/audit/receipts.jsonl` | where deletion receipts go: the `audit_log` table, a JSONL file, the console, or `receipt#` items in the table |
| `LLM_PROVIDER`, `BEDROCK_MODEL_ID` | `offline`, `us.anthropic.claude-sonnet-4-6` | `bedrock` is the live provider; `anthropic` needs `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL` default `claude-opus-5-5`) |
| `SPEECH_PROVIDER`, `TRANSCRIBE_OUTPUT_BUCKET` | `offline`, unset | `transcribe` uses Transcribe Medical over the audio bucket |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SMTP_URL` | `console`, a placeholder, unset | console prints the message; `smtp`; `ses` |
| `EMAIL_QUEUE`, `SQS_QUEUE_URL` | `none`, unset | `sqs` enqueues instead of sending; `npm run email-worker` consumes |
| `MAX_UPLOAD_BYTES` | 15 MB | PDF and audio limit |

Scripts: `dev`, `start`, `test`, `typecheck`, `demo`, `seed`, `sweep`, `show-audit`, `check-sql`, `fetch-rds-bundle`, `setup-dynamo`, `ensure-s3-lifecycle`, `verify-infra`, `live-ingest`, `email-worker`, `export-contract`, `make-fixture-pdf`. `docker-compose.yml` and `scripts/dynamodb-local.sh` run DynamoDB Local for `DOC_STORE=dynamo` without the team account.

## How the data lives and dies

SQL (SQLite locally, MariaDB on RDS): `patients` (first name, last name, date of birth, zip code, email, phone, preferred language, active link id and its expiry), `links` (only `sha256(linkId)`, status, `expires_at = created_at + 30 days`, the per-link AES-256-GCM data key, picked language, languages held, audio key, emailed-at), `jobs` (the stage machine, the safety result, metadata), `audit_log` (events and deletion receipts, never PHI). One portable schema; `src/db/migrate.ts` rewrites the few MySQL-specific tokens.

Document store (DynamoDB, or the SQL twin): every item is sealed with the link's data key before it is written and bound by AAD to its own `uid` and key version, so the table never holds plaintext and an item cannot be moved to another slot. The raw link id appears in the 202 response, the email and the patient row only.

Day 30 has four layers, from the fastest to the backstop:

1. Read time: every patient endpoint compares `expires_at` with the app clock and answers 410 before touching the store.
2. The purge job (`PURGE_INTERVAL_MS`, `npm run sweep`): destroys the data key first (crypto-shredding: anything still stored is unreadable from that moment), deletes every document-store item and the audio object with one deletion receipt each, marks the link purged, clears the patient's active link.
3. DynamoDB TTL on `expiresAt` and the S3 lifecycle rule delete whatever is left on AWS; the Streams and S3 event handlers turn those deletions into the same receipts.
4. The backstop sweep inside the purge job deletes any expired item or 30-day-old audio file the per-link loop did not reach, with receipts.

Receipts say what was deleted (the item `uid` or the object key), when, by which mechanism (`purge_job`, `dynamodb_ttl`, `s3_lifecycle`, `local_sweeper`) and for which link hash, and they outlive the data.

## Safety and what stays under human control

- The deterministic safety check runs after every model call: every medication the source names, with its dose, frequency and duration, must appear in the output, and nothing in the output may be absent from the source. A failure holds the summary as `needs_review` (423 for the patient, no email) until a clinician re-runs it through `POST /synthesize`. Translations are checked too: names and doses verbatim, every number preserved (a digit standing in for "once" or "twice" is accepted), the same ids, counts, statuses and tiers; a translation that fails is refused and not cached.
- The backend never writes anyone's words. It rephrases and translates the clinician's own discharge instructions for the patient and speaks as itself; it never drafts a message, note or reply for a person to send as their own.
- No PHI in logs (pino redaction), in the audit log, in receipts, in URLs, or in error bodies. Audio objects and document items are named by the link hash only.
- The provider key is light auth for a hackathon front end; the patient credential is the 128-bit link id, rate limited.

## What `alt-backend` adds

The other branch of this repo (`alt-backend`) keeps the surfaces this branch leaves out, as its OpenAPI listed them on 2026-10-10: the patient checklist (`GET /checklist`, `POST /checklist/complete`), the demo clock and purge endpoints under `/admin/*`, the caregiver fields on `POST /ingest`, `GET /languages`, `GET /audit` and `GET /audit/receipts`, `GET /contracts`, and extra keys on each step such as `category` and `due`. This branch folds the language list into OpenAPI, moves the demo clock to `DEMO_NOW` plus `npm run sweep`, and prints the audit log with `npm run show-audit`.

## Tests

`npm test`: 84 passing of 84, 16 files, offline (`LLM_PROVIDER=offline`, SQLite in memory). Coverage: patients, provider auth and the surface, ingest text/PDF/audio with the 202 and the job, needs_review on a dropped medication, summary and the fixed JSON, translate cache-first with Spanish, Mandarin and Arabic, a refused translation, `GET /p/:token`, `POST /synthesize` in both modes, read-time 410, purge with receipts and audio deletion, DEMO_NOW, the SQL dialect rewrites and `DATABASE_URL` parsing, the Secrets Manager bootstrap with an injected fetcher, the DynamoDB store on a fake table with `uid` keys and paging, the S3 store on a fake bucket, the lifecycle merge, the stream and S3 event handlers, the safety checks on all five examples, the contract and fixtures, and the OpenAPI document against the mounted routes.

## Limitations

The MariaDB path is written against the mysql2 API and tested on SQLite, not against RDS from here (see the table above). Per-link listing in DynamoDB is a filtered scan. The simplifier and translator prompts are starting points for the teammate who owns them; the contract and the safety check are what the rest of the system relies on. Audio transcription runs on the offline fixture unless Transcribe Medical is enabled.
