# DischargeAI backend: design (Kiro design doc)

Branch `backend`. The team's backend tasks doc first (exact routes, keys and DynamoDB attributes), Advik's Granola note second, the diagram's additions third, the real AWS resource names over all of them. See the README for the run-through; this document is the architecture.

## Architecture

```
 Provider app (teammates)                               Patient phone (teammates)
      |  x-provider-key                                       |  link id only
      v                                                       v
 +-----------------------------------------------------------------------------------+
 |  Express 5 + zod  (src/app.ts)                                                     |
 |  /patients /ingest /jobs/:id /synthesize | /llm-sumary /translation /p/:token     |
 |  /health  /docs  /openapi.json                                                     |
 +----------+------------------------+-------------------------------+---------------+
            |                        |                               |
  +---------v----------+   +---------v-----------+        +----------v-------------------+
  | SQL (src/db)       |   | Lane 3 (src/pipeline)|        | Document store (src/docstore) |
  |  SQLite local      |   |  speechToText        |        |  DynamoDB discharge-summaries |
  |  MariaDB on RDS    |   |  simplify (Bedrock)  |        |   hash key uid, TTL expiresAt |
  |   via mysql2 + TLS |   |  safetyChecks        |        |   one plain item per summary  |
  |  patientinfo (ro), |   |  translate (Bedrock) |        |  SQL twin (summaries table)   |
  |  activeLinks, jobs,|   |  runPipeline         |        |                               |
  |  audit_log         |   |                      |        |                               |
  +--------------------+   +---------------------+        +-------------------------------+
            |                        |                               |
  +---------v----------+   +---------v-----------+        +----------v-------------------+
  | Secrets Manager    |   | Audio (src/data)     |        | Day 30 (src/pipeline/purge)   |
  |  hackhealth/secret |   | PDF + audio (data/)  |        |  read-time 410, purge job,    |
  |  -> MYSQL_*,       |   |  S3 emrpdf-rh,       |        |  TTL + lifecycle backstops,   |
  |     DYNAMO_TABLE,  |   |  emraudio-rh, SSE,   |        |  deletion receipts (src/audit)|
  |     DYNAMO_PK      |   |  30-day lifecycle,   |        +-------------------------------+
  +--------------------+   |  local twin fallback |
                           +---------------------+
  Email: console | smtp | ses (@aws-sdk/client-sesv2); optional EMAIL_QUEUE=sqs -> scripts/email-worker.ts
```

## Module layout (`backend/`)

```
src/
  index.ts            boot: loadRuntimeEnv (dotenv + Secrets Manager) -> createContext -> listen
  bootstrap.ts        the configuration sequence shared by the server and every script
  secrets.ts          GetSecretValue with a timeout; secret keys -> env (env wins); names-only report
  config.ts           zod-validated env -> Config
  context.ts          wires SQL, the summary store, PDF and audio stores, receipts sink, providers, mailer, queue
  app.ts              routes, provider auth on /patients /ingest /jobs /synthesize, rate limit on patient paths
  clock.ts            app clock; DEMO_NOW pins it at boot
  db/                 index.ts (SqliteDb, MySqlDb, DATABASE_URL parsing), migrate.ts (per-dialect rewrites),
                      migrations/0001_init.sql (portable), 0002_patientinfo.{sqlite,mysql}.sql, repos/{patients,activeLinks,jobs,audit}.ts,
                      seed.ts (local SQLite only, npm run seed)
  docstore/           types.ts (the one-item-per-summary shape), dynamo.ts, local.ts (SQL twin)
  crypto/             sumId.ts (128-bit random path, base64url; logRef = 8 hex of its sha256 for logs)
  pipeline/           runPipeline.ts, simplify.ts, translate.ts, speechToText.ts, safetyChecks.ts, languages.ts,
                      prompts.ts, bedrock/{converse,simplify,translate}.ts, anthropic/*, transcribe/medical.ts,
                      offline/{fixtures,rules}.ts, ingestJob.ts (stage machine + synthesizeLink + emailLinks),
                      purge.ts (the self-destruct), queue.ts (p-queue, concurrency 1), readability.ts
  routes/             health, patients, ingest, jobs, synthesize, llmSummary, translation, summary, translate, patientLink,
                      linkAccess (shared)
  data/               objects.ts (ObjectStore for PDFs and audio, local twin, auto/s3/local resolution), s3/objects.ts
  audit/              receipts.ts (DeletionReceipt, sinks sql/file/console/dynamo), dynamoSink.ts,
                      streamHandler.ts (DynamoDB Streams, TTL REMOVE), s3EventHandler.ts (lifecycle expirations)
  email/              mailer.ts, templates.ts, queue.ts
  extract/            pdfToText.ts (pdf-parse, pdfjs fallback; base64 decoding), text.ts (page markers out)
  middleware/         providerAuth, rateLimit, upload (multer memory), errors
  contracts/          aiOutput.ts (zod, strict five keys)
contracts/            ai-output.schema.json, ai-output.ts (published for the other lanes)
scripts/              demo.sh sweep.ts show-audit.ts check-sql.ts fetch-rds-bundle.sh setup-dynamo.ts setup-s3.ts
                      ensure-s3-lifecycle.ts verify-infra.ts live-ingest.ts seed.ts email-worker.ts export-contract.ts
certs/                global-bundle.pem (public RDS certificate bundle, AWS step 1)
fixtures/             discharge-summaries/*, offline/ai-output/example-{1..5}.en.json + example-1.{es,zh,ar}.json,
                      offline/transcripts/dictation-1.json, patients.seed.json, live-samples/*
test/                 15 vitest files
```

## Data model

SQL, one portable schema (`src/db/migrations/0001_init.sql`), `VARCHAR` for every keyed column so MariaDB can index it, ISO timestamps from the app clock:

- The team's `patientinfo` (read only, never seeded by the server): columns discovered at startup and mapped to `GET /patients`'s `ID, DOB, FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName` by name, ignoring case and underscores (`src/db/repos/patients.ts`). `0002_patientinfo.*.sql` creates it with those columns only where it is missing.
- `activeLinks(id AUTOINCREMENT, sumId UNIQUE, patientID FK, createdAt, expiresAt = createdAt + 30 days, status pending|ready|needs_review|failed|expired|purged, language, languages JSON, pdfKey, audioKey, lastViewedAt, emailedAt)`: the tasks doc's table, the `sumId` stored as-is.
- `jobs(id, sum_id FK, stage, input_kind, error, safety JSON, meta JSON, created_at, updated_at)`.
- `audit_log(id AUTOINCREMENT, event, sum_id, actor provider|patient|system, at, details JSON)`; deletion receipts are rows with `event = deletion.receipt`.
- `summaries(uid PK, item JSON, expires_at, created_at)`: the SQL twin of the DynamoDB table.
- `schema_migrations(name, applied_at)`.

MySQL rewrites in `migrate.ts`: `AUTOINCREMENT -> AUTO_INCREMENT`, `TEXT -> MEDIUMTEXT`, `CREATE INDEX IF NOT EXISTS -> CREATE INDEX` (duplicate index errors ignored). Statements are split and run one by one. Files named `NNNN_x.sqlite.sql` / `NNNN_x.mysql.sql` run on that dialect only (0002 rebuilds `activeLinks` without the old foreign key on SQLite and drops it on MySQL, ignoring "does not exist"). The summary upsert is spelled per dialect (`ON CONFLICT (uid) DO UPDATE` / `ON DUPLICATE KEY UPDATE`).

DynamoDB `discharge-summaries` (single hash key `uid`, TTL `expiresAt`), one plain item per summary:

```
{ uid: "<sumId>", "sum-id": "<sumId>", patientID, "raw-text", "llm-summary": <AiOutput, English>,
  translations: { "<lang>": <AiOutput> }, language, status: processing|ready|needs_review|failed,
  createdAt: ISO, expiresAt: <epoch seconds>,
  inputKind: text|pdf|audio, pdfKey?, audioKey?, safety?, meta? }
```

`raw-text` is written at ingest for pasted text and after extraction or transcription otherwise; `llm-summary` and the produced translations are written when the LLM returns. Teammates read these attributes directly and their own LLM agent may write `llm-summary` into the same item. Optional receipts (`AUDIT_SINK=dynamo`): `uid: "receipt#<sumId>#<receiptId>"`, no `expiresAt`, so TTL never removes them.

## The random path

`sumId`: 16 random bytes, base64url (22 characters). It is the `activeLinks.sumId`, the DynamoDB `uid` and `sum-id`, the PDF and audio object key prefix, the `sum-id`/`sum_id` query value and the `/p/:token` path. Logs carry `logRef(sumId)` (8 hex characters of its sha256), never the id. Nothing is encrypted at the application layer on this branch: the tasks doc has teammates read the item directly, DynamoDB and S3 encrypt at rest, and access stays with the team role.

## Lane 3 (the pipeline)

`runPipeline({ rawText | transcript | audio, languages })`: speech to text when audio is given, simplify to the English contract, deterministic safety checks (every source medication with dose, frequency and duration present in the output; nothing in the output absent from the source), then one translation call per language with the translation check (names and doses verbatim, numbers preserved with a digit allowed for once/twice/three/four times, same ids, counts, statuses, tiers). A safety failure blocks translation and the record becomes `needs_review`. Providers: offline (fixtures by fingerprint for the five examples, rules otherwise), Bedrock Converse with tool-based JSON on the verified inference profiles, Anthropic direct optional.

Ingest stage machine, persisted in `jobs`: `received -> extracting (pdf: pdfToText) | transcribing (audio) -> simplifying -> stored -> emailing -> done`, or `-> needs_review` (no email), any stage `-> failed`. `emailLinks` sends the link to the patient's `email` and to `caregiverEmail` when present. `POST /synthesize { linkId }` re-runs `synthesizeLink` over the stored `raw-text`, replaces `llm-summary` and the produced translations, drops stale on-demand translations, updates `activeLinks.languages` and the status, and emails once it verifies (once only, `emailedAt`).

## Patient reads (`src/routes/linkAccess.ts`)

`resolveSummary`: 400 malformed -> 404 unknown -> 410 purged -> 410 expired (clock comparison at read time; the link is marked and audited) -> 425 processing -> 423 needs_review -> 500 failed -> the item's `llm-summary`. `languageFor` (the tasks doc's `GET /translation`): English is the `llm-summary`; another language is served from `translations[lang]` (or its base language) when present, otherwise the translation agent runs once on the `llm-summary`, the result is checked, saved under `translations[lang]`, added to `activeLinks.languages`, and served. A failed check answers 422 and caches nothing.

## Day 30

Read time (410), the purge job (`PURGE_INTERVAL_MS`, `npm run sweep` with `DEMO_NOW` for demos), DynamoDB TTL and the S3 lifecycle rule as backstops with their event handlers writing receipts, and the backstop sweep inside the purge job for anything left. Receipts (`src/audit/receipts.ts`): `{ receiptId, sumId, deleted: record|pdf|audio|transcript, mechanism: purge_job|dynamodb_ttl|s3_lifecycle|local_sweeper, source, at, uid?, key?, expiresAt? }`, never content.

## Configuration resolution

1. `.env` (values already in the environment win).
2. Secrets Manager `hackhealth/secret` when `SECRETS_BOOTSTRAP=auto` and `AWS_SECRET_ARN` is set: `mysql-host/port/user/password/db -> MYSQL_*`, `dynamodb-table -> DYNAMO_TABLE`, `dynamodb-table-pk -> DYNAMO_PK`; environment values win; failure logs the reason and runs local.
3. SQL: `DATABASE_URL` -> `MYSQL_HOST` -> `DATABASE_FILE`. Summary store: `DOC_STORE=auto` means DynamoDB when the secret resolved. PDFs and audio: `PDF_STORE` / `AUDIO_STORE=auto` means S3 when the secret resolved and `HeadBucket` answers, else the local folder with the reason in `/health`.

## Decisions

- One portable SQL schema with dialect rewrites instead of two migration sets: MariaDB is the production path, SQLite the test path, and the repositories share every query but the upsert.
- One plain item per summary on the real table's single hash key `uid`, as the tasks doc lays it out: teammates read and write the same attributes, no new infrastructure, filtered scans for the backstop sweep at hackathon scale.
- Receipts in `audit_log` by default, beside the link's other events; the Lambda handlers can use the same table over RDS, a file, the console, or `receipt#` items in the DynamoDB table.
- `DEMO_NOW` instead of an admin endpoint: no HTTP surface can move the clock; a second process sweeps against the same stores.
- Stale translations are deleted on re-synthesis so the cache-first rule never serves a translation of an older English.
