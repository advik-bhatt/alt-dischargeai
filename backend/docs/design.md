# DischargeAI backend: design (Kiro design doc)

Branch `backend`. The note's endpoints and data plan first, the diagram's additions second, the real AWS resource names over both. See the README for the run-through; this document is the architecture.

## Architecture

```
 Provider app (teammates)                               Patient phone (teammates)
      |  x-provider-key                                       |  link id only
      v                                                       v
 +-----------------------------------------------------------------------------------+
 |  Express 5 + zod  (src/app.ts)                                                     |
 |  /patients  /ingest  /jobs/:id  /synthesize   |   /summary  /translate  /p/:token |
 |  /health  /docs  /openapi.json                                                     |
 +----------+------------------------+-------------------------------+---------------+
            |                        |                               |
  +---------v----------+   +---------v-----------+        +----------v-------------------+
  | SQL (src/db)       |   | Lane 3 (src/pipeline)|        | Document store (src/docstore) |
  |  SQLite local      |   |  speechToText        |        |  DynamoDB discharge-summaries |
  |  MariaDB on RDS    |   |  simplify (Bedrock)  |        |   hash key uid, TTL expiresAt |
  |   via mysql2 + TLS |   |  safetyChecks        |        |  SQL twin (documents table)   |
  |  patients, links,  |   |  translate (Bedrock) |        |  SecureDocs: AES-256-GCM per  |
  |  jobs, audit_log   |   |  runPipeline         |        |   link key, AAD = uid|version |
  +--------------------+   +---------------------+        +-------------------------------+
            |                        |                               |
  +---------v----------+   +---------v-----------+        +----------v-------------------+
  | Secrets Manager    |   | Audio (src/data)     |        | Day 30 (src/pipeline/purge)   |
  |  hackhealth/secret |   |  S3 emraudio-rh, SSE |        |  read-time 410, purge job,    |
  |  -> MYSQL_*,       |   |  lifecycle 30 days   |        |  TTL + lifecycle backstops,   |
  |     DYNAMO_TABLE,  |   |  local twin fallback |        |  deletion receipts (src/audit)|
  |     DYNAMO_PK      |   +---------------------+        +-------------------------------+
  +--------------------+
  Email: console | smtp | ses (@aws-sdk/client-sesv2); optional EMAIL_QUEUE=sqs -> scripts/email-worker.ts
```

## Module layout (`backend/`)

```
src/
  index.ts            boot: loadRuntimeEnv (dotenv + Secrets Manager) -> createContext -> listen
  bootstrap.ts        the configuration sequence shared by the server and every script
  secrets.ts          GetSecretValue with a timeout; secret keys -> env (env wins); names-only report
  config.ts           zod-validated env -> Config
  context.ts          wires SQL, document store, audio store, receipts sink, providers, mailer, queue
  app.ts              routes, provider auth on /patients /ingest /jobs /synthesize, rate limit on patient paths
  clock.ts            app clock; DEMO_NOW pins it at boot
  db/                 index.ts (SqliteDb, MySqlDb, DATABASE_URL parsing), migrate.ts (per-dialect rewrites),
                      migrations/0001_init.sql (portable), repos/{patients,links,jobs,audit}.ts, seed.ts
  docstore/           types.ts (uid composition), dynamo.ts, local.ts, secure.ts (encrypt then store), documents.ts (stored shapes)
  crypto/             linkId.ts (128-bit ids, sha256 at rest), envelope.ts (AES-256-GCM with AAD)
  pipeline/           runPipeline.ts, simplify.ts, translate.ts, speechToText.ts, safetyChecks.ts, languages.ts,
                      prompts.ts, bedrock/{converse,simplify,translate}.ts, anthropic/*, transcribe/medical.ts,
                      offline/{fixtures,rules}.ts, ingestJob.ts (stage machine + synthesizeLink + emailPatientLink),
                      purge.ts (the self-destruct), queue.ts (p-queue, concurrency 1), readability.ts
  routes/             health, patients, ingest, jobs, synthesize, summary, translate, patientLink, linkAccess (shared)
  data/               audio.ts (AudioStore, local twin, auto/s3/local resolution), s3/audio.ts
  audit/              receipts.ts (DeletionReceipt, sinks sql/file/console/dynamo), dynamoSink.ts,
                      streamHandler.ts (DynamoDB Streams, TTL REMOVE), s3EventHandler.ts (lifecycle expirations)
  email/              mailer.ts, templates.ts, queue.ts
  extract/            pdf.ts (pdf-parse, pdfjs fallback), text.ts (page markers out)
  middleware/         providerAuth, rateLimit, upload (multer memory), errors
  contracts/          aiOutput.ts (zod, strict five keys)
contracts/            ai-output.schema.json, ai-output.ts (published for the other lanes)
scripts/              demo.sh sweep.ts show-audit.ts check-sql.ts fetch-rds-bundle.sh setup-dynamo.ts
                      ensure-s3-lifecycle.ts verify-infra.ts live-ingest.ts seed.ts email-worker.ts export-contract.ts
certs/                global-bundle.pem (public RDS certificate bundle, AWS step 1)
fixtures/             discharge-summaries/*, offline/ai-output/example-{1..5}.en.json + example-1.{es,zh,ar}.json,
                      offline/transcripts/dictation-1.json, patients.seed.json, live-samples/*
test/                 16 vitest files
```

## Data model

SQL, one portable schema (`src/db/migrations/0001_init.sql`), `VARCHAR` for every keyed column so MariaDB can index it, ISO timestamps from the app clock:

- `patients(id, first_name, last_name, date_of_birth, zip_code, email, phone, preferred_language, active_link_id, active_link_expires_at, created_at)`.
- `links(link_id_hash PK, patient_id FK, status pending|ready|needs_review|failed|expired|purged, created_at, expires_at = created_at + 30 days, key_version, enc_key BLOB NULL, language, languages JSON, audio_key, last_viewed_at, emailed_at)`.
- `jobs(id, link_id_hash FK, stage, input_kind, error, safety JSON, meta JSON, created_at, updated_at)`.
- `audit_log(id AUTOINCREMENT, event, link_id_hash, actor provider|patient|system, at, details JSON)`; deletion receipts are rows with `event = deletion.receipt`.
- `documents(uid PK, pk, sk, ciphertext, iv, tag, key_version, expires_at, created_at)`: the SQL twin of the DynamoDB table.
- `schema_migrations(name, applied_at)`.

MySQL rewrites in `migrate.ts`: `AUTOINCREMENT -> AUTO_INCREMENT`, `BLOB -> LONGBLOB`, `TEXT -> MEDIUMTEXT`, `CREATE INDEX IF NOT EXISTS -> CREATE INDEX` (duplicate index errors ignored). Statements are split and run one by one. The document upsert is spelled per dialect (`ON CONFLICT (uid) DO UPDATE` / `ON DUPLICATE KEY UPDATE`).

DynamoDB `discharge-summaries` (single hash key `uid`, TTL `expiresAt`):

```
{ uid: "<linkIdHash>#raw" | "<linkIdHash>#simplified" | "<linkIdHash>#translation#<lang>",
  pk: "<linkIdHash>", sk: "raw" | "simplified" | "translation#<lang>",
  ciphertext: Binary, iv: Binary(12), tag: Binary(16), keyVersion: 1,
  expiresAt: <epoch seconds>, createdAt: ISO }
```

Optional receipts (`AUDIT_SINK=dynamo`): `uid: "receipt#<linkIdHash>#<receiptId>"`, no `expiresAt`, so TTL never removes them.

What the items hold (`src/docstore/documents.ts`): `raw` = `{ text, kind, linkId, audioKey?, transcript? }`; `simplified` = `{ output (English AiOutput), safety, verified, provider, model, usage, fixture, latencyMs, sourceChars, inputKind, createdAt }`; `translation#<lang>` = `{ output, check, provider, model, createdAt }`.

## Crypto

- Link id: 16 random bytes, base64url (22 chars). The store holds `sha256(linkId)` only. The raw id appears in the 202 response, the email and `patients.active_link_id`.
- Per-link data key: 32 random bytes in `links.enc_key`. Every item: AES-256-GCM, fresh 12-byte IV, 16-byte tag, AAD = `linkIdHash|sk|keyVersion`.
- Purge sets `enc_key = NULL` first (crypto-shredding), then deletes the items and the audio object. A lagging TTL or lifecycle delete is already unreadable.

## Lane 3 (the pipeline)

`runPipeline({ rawText | transcript | audio, languages })`: speech to text when audio is given, simplify to the English contract, deterministic safety checks (every source medication with dose, frequency and duration present in the output; nothing in the output absent from the source), then one translation call per language with the translation check (names and doses verbatim, numbers preserved with a digit allowed for once/twice/three/four times, same ids, counts, statuses, tiers). A safety failure blocks translation and the record becomes `needs_review`. Providers: offline (fixtures by fingerprint for the five examples, rules otherwise), Bedrock Converse with tool-based JSON on the verified inference profiles, Anthropic direct optional.

Ingest stage machine, persisted in `jobs`: `received -> extracting (pdf) | transcribing (audio) -> simplifying -> stored -> emailing -> done`, or `-> needs_review` (no email), any stage `-> failed`. `POST /synthesize { linkId }` re-runs `synthesizeLink` over the stored raw text, replaces `simplified` and the produced translations, deletes stale on-demand translations, updates `links.languages` and the status, and emails the patient once it verifies (once only, `emailed_at`).

## Patient reads (`src/routes/linkAccess.ts`)

`resolveLink`: 400 malformed -> 404 unknown -> 410 purged -> 410 expired (clock comparison at read time; the link is marked and audited) -> 425 processing -> 423 needs_review -> 500 failed -> decrypt `simplified`. `serveLanguage`: English is the stored LLM response; another language is served from `translation#<lang>` (or its base language) when present, otherwise the translation agent runs once, the result is checked, stored with the link's expiry, added to `links.languages`, and served. A failed check answers 422 and caches nothing.

## Day 30

Read time (410), the purge job (`PURGE_INTERVAL_MS`, `npm run sweep` with `DEMO_NOW` for demos), DynamoDB TTL and the S3 lifecycle rule as backstops with their event handlers writing receipts, and the backstop sweep inside the purge job for anything left. Receipts (`src/audit/receipts.ts`): `{ receiptId, linkIdHash, deleted: record|audio|transcript, mechanism: purge_job|dynamodb_ttl|s3_lifecycle|local_sweeper, source, at, uid?, key?, expiresAt? }`, never content.

## Configuration resolution

1. `.env` (values already in the environment win).
2. Secrets Manager `hackhealth/secret` when `SECRETS_BOOTSTRAP=auto` and `AWS_SECRET_ARN` is set: `mysql-host/port/user/password/db -> MYSQL_*`, `dynamodb-table -> DYNAMO_TABLE`, `dynamodb-table-pk -> DYNAMO_PK`; environment values win; failure logs the reason and runs local.
3. SQL: `DATABASE_URL` -> `MYSQL_HOST` -> `DATABASE_FILE`. Document store: `DOC_STORE=auto` means DynamoDB when the secret resolved. Audio: `AUDIO_STORE=auto` means S3 when the secret resolved and `HeadBucket` answers, else the local folder with the reason in `/health`.

## Decisions

- One portable SQL schema with dialect rewrites instead of two migration sets: MariaDB is the production path, SQLite the test path, and the repositories share every query but the upsert.
- Single hash key `uid` on the real table, with `pk`/`sk` kept as attributes: no new infrastructure, filtered scans at hackathon scale.
- Receipts in `audit_log` by default, beside the link's other events; the Lambda handlers can use the same table over RDS, a file, the console, or `receipt#` items in the DynamoDB table.
- `DEMO_NOW` instead of an admin endpoint: no HTTP surface can move the clock; a second process sweeps against the same stores.
- Stale translations are deleted on re-synthesis so the cache-first rule never serves a translation of an older English.
