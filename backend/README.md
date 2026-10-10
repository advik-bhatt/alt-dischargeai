# DischargeAI backend (branch `backend`)

Discharge summaries in (pasted text, a PDF, or dictated audio), a plain-language patient link out, and every piece of data self-destructs 30 days after it was created. Node 24, TypeScript, Express 5. Claude on Amazon Bedrock does the simplifying and translating; a deterministic safety check verifies every medication, dose and frequency before anything reaches a patient.

## Precedence

The team's written backend tasks doc ("HealthHack Backend Tasks") is the contract: its five items ship here with its exact route names, query parameters, body keys and DynamoDB attribute names, typos included (`GET /llm-sumary?sum-id=`). Advik's Granola note comes next (SQL patient table, `GET /patients`, `POST /ingest` with a 202 and asynchronous PDF-to-text, LLM simplification, DynamoDB storage and the patient email, cache-first translation). The team architecture diagram fills in whatever both are silent on (`POST /synthesize`, `GET /p/:token`, the fixed per-language JSON, S3 audio with the 30-day lifecycle, deletion receipts, light provider auth, Transcribe Medical, safety checks). The real AWS resources override the names in all three: the table is `discharge-summaries`, the buckets are `emrpdf-rh` and `emraudio-rh`.

## Run it

```sh
cd backend && npm install && npm run dev
```

Node 24 (`.nvmrc`; `engines` is `>=24`). With nothing configured the backend runs fully local: SQLite, the SQL twin of the DynamoDB table, local folders for PDFs and audio, offline AI providers driven by fixtures, and the console email transport. Six synthetic patients are seeded at boot. Docs are at `http://localhost:4000/docs`.

With AWS credentials in the shell (or an instance role on the team's EC2 box) the backend reads the team secret at boot and switches to MariaDB on RDS, DynamoDB and S3 by itself. See "Team infrastructure". Outside the VPC, RDS port 3306 is unreachable and the server exits with `connect ETIMEDOUT`; add `DATABASE_URL=sqlite:data/live.db` to keep Bedrock, DynamoDB and S3 live while SQL stays local.

```sh
npm test            # offline, no keys
npm run typecheck
npm run demo        # the narrative below, against the running server
```

## The team API (backend tasks doc)

Provider routes need the header `x-provider-key: dev-provider-key` (the `PROVIDER_API_KEY` default). Patient routes need no header; the 128-bit random `sumId` is the credential.

| Task | Route | What it does |
| --- | --- | --- |
| 1 | `GET /patients` (provider) | `{ "patients": [ { "ID", "DOB", "FirstName", "LastName", "ZipCode", "email", "phoneNumber", "caregiverEmail", "caregiverName" } ] }`, exactly those keys |
| 2 | `pdfToText` (`src/extract/pdfToText.ts`) | converts a PDF buffer to text; the ingester calls it for `type: "pdf"` |
| 3 | `POST /ingest` (provider) | JSON `{ "data", "type": "text" \| "pdf", "patientID", "language"? }`; answers `202 { "statusCode": 202, "message": "ingestion started", "sumId", "link", "jobId", "expiresAt" }` at once. A PDF goes to S3 `emrpdf-rh` and through `pdfToText`; the random path `sumId` goes into the SQL `activeLinks` table and becomes the DynamoDB `uid`; then the LLM runs, `llm-summary` and `sum-id` are saved on that item, and the link is emailed to the patient's `email` and `caregiverEmail`. Any other `type` answers `400 { "statusCode": 400, "message": "type must be text or pdf" }` |
| 4 | `GET /llm-sumary?sum-id=` (patient) | the `llm-summary` from the DynamoDB item; `/llm-summary` and `?sum_id=` work too |
| 5 | `GET /translation?lang=&sum_id=` (patient) | cache-first: returns `translations[lang]` from the item when present, otherwise translates the `llm-summary`, saves it under `translations[lang]` and returns it (`fromCache` says which) |

Errors on every route carry `{ "statusCode", "message" }`. Patient reads answer 404 unknown, 410 expired or deleted (checked at read time, before any sweeper runs), 425 still processing, 423 held for clinician review (safety checks failed; no email was sent).

## Test the five tasks with curl

Start the server in one terminal (`cd backend && npm install && npm run dev`, Node 24), then paste these in another. Everything is inline JSON; nothing reads a local file.

### Task 1: `GET /patients`

```sh
# The list, with exactly ID, DOB, FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/patients

# Without the provider key: 401 {"statusCode":401,...}
curl -s -w ' HTTP %{http_code}\n' http://localhost:4000/patients

# Search by name, email or phone
curl -s -H "x-provider-key: dev-provider-key" "http://localhost:4000/patients?q=reyes"
```

Checked on 2026-10-10 against `npm run dev` on this commit: six synthetic patients with the nine keys (`pt-0004` has no caregiver, so both caregiver keys are `null`), 401 without the key, one match for `reyes`.

### Task 2: `pdfToText`

The tasks doc defines it as a function the ingester calls, not a route, so it is tested by ingesting a PDF and reading the job. The `data` below is a one-page PDF (885 bytes, `fixtures/discharge-summaries/curl-sample.pdf`) as base64:

```sh
# Ingest the PDF; the response carries the jobId and the sumId
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"pdf","patientID":"pt-0001","data":"JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMzQwID4+CnN0cmVhbQpCVAovRjEgMTEgVGYKMTQgVEwKNzIgNzIwIFRkCihEaXNjaGFyZ2UgZGlhZ25vc2lzOiBoZWFydCBmYWlsdXJlLikgVGoKVCogKE5ldyBtZWRpY2F0aW9uczopIFRqClQqICgtIEZ1cm9zZW1pZGUgNDAgbWcgYnkgbW91dGggb25jZSBkYWlseSBmb3Igc3dlbGxpbmcpIFRqClQqIChEaXNjaGFyZ2UgaW5zdHJ1Y3Rpb25zOikgVGoKVCogKC0gV2VpZ2ggeW91cnNlbGYgZXZlcnkgbW9ybmluZykgVGoKVCogKC0gRm9sbG93IHVwIHdpdGggY2FyZGlvbG9neSB3aXRoaW4gMSB3ZWVrKSBUagpUKiAoUmV0dXJuIHByZWNhdXRpb25zOikgVGoKVCogKC0gQ2FsbCA5MTEgZm9yIGNoZXN0IHBhaW4pIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo3MDIKJSVFT0YK"}' \
  http://localhost:4000/ingest

# Paste the jobId from that response: stage "done", meta.pdfPages 1, meta.pdfEngine "pdf-parse", meta.sourceChars 247
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/jobs/<jobId>

# Paste the sumId: the summary built from the extracted text (Furosemide 40 mg, once a day by mouth, new)
curl -s "http://localhost:4000/llm-sumary?sum-id=<sumId>"
```

Checked on 2026-10-10 against `npm run dev` on this commit: 202, then `done` with `verified: true`, one page, 247 characters, and the PDF saved as `data/pdf/<sumId>.pdf` (the local twin of `emrpdf-rh`). `npm test` checks the function returns those eight lines exactly and that this README carries that exact PDF.

With the default `LLM_PROVIDER=offline`, the simplifier is rule-based: it reads summaries laid out with headings ("New medications:", "Discharge instructions:", "Return precautions:") and bulleted lines, like the samples here and the five examples in `fixtures/`. Free prose it cannot place is caught by the safety check and held for review (`423`), never shown with a medication missing. Start the server with `LLM_PROVIDER=bedrock` and AWS credentials to have Claude handle any layout.

### Task 3: `POST /ingest`

```sh
# Text: 202 {"statusCode":202,"message":"ingestion started","sumId":...,"link":...,"jobId":...,"expiresAt":...}
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"text","patientID":"pt-0001","language":"es","data":"Discharge diagnosis: heart failure.\nNew medications:\n- Furosemide 40 mg by mouth once daily for swelling\nDischarge instructions:\n- Weigh yourself every morning\n- Follow up with cardiology within 1 week\nReturn precautions:\n- Call 911 for chest pain"}' \
  http://localhost:4000/ingest

# PDF: the task 2 command above (type "pdf", data = base64)

# Any other type: 400 {"statusCode":400,"error":"invalid_type","message":"type must be text or pdf"}
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"docx","patientID":"pt-0001","data":"hello"}' http://localhost:4000/ingest

# Unknown patient: 404; no provider key: 401
curl -s -H "x-provider-key: dev-provider-key" -H "content-type: application/json" \
  -d '{"type":"text","patientID":"pt-9999","data":"hello"}' http://localhost:4000/ingest
curl -s -H "content-type: application/json" -d '{"type":"text","patientID":"pt-0001","data":"hello"}' http://localhost:4000/ingest

# The activeLinks row: the patient now has an active link whose sumId matches the 202
curl -s -H "x-provider-key: dev-provider-key" http://localhost:4000/patients/pt-0001
```

The server terminal prints two emails with the link: `To: harold.jennings@example.test` (the patient) and `To: june.jennings@example.test` (the caregiver). The job's progress is at `GET /jobs/<jobId>` (provider key), as in task 2.

Checked on 2026-10-10 against `npm run dev` on this commit: every response as described, the job `done` with `verified: true` and languages `["en", "es"]`, both emails printed.

Checked live the same day from the build container (team secret loaded, `LLM_PROVIDER=bedrock`, `DATABASE_URL=sqlite:data/live.db` because RDS port 3306 is not reachable from there): the text above for `pt-0001` and the task 2 PDF for `pt-0002` both went `done` and verified on `us.anthropic.claude-sonnet-4-6` (about 5.5 s of model time each, both jobs finished within 14 s). Read back with boto3, each `discharge-summaries` item had `uid` equal to `sum-id`, `patientID`, `raw-text`, `llm-summary` (a map), `translations` (a map holding `es`), `language`, `status: ready`, `createdAt` and `expiresAt` (a number, 30 days out); TTL is enabled on `expiresAt`. The PDF was in `emrpdf-rh` as `<sumId>.pdf`, 885 bytes, SSE AES256. `emrpdf-rh` was created that day by `npm run setup-s3 -- --bucket emrpdf-rh` (public access blocked, AES256 by default, objects expire after 30 days); a second run changed nothing.

### Task 4: `GET /llm-sumary?sum-id=`

Use the `sumId` from a task 3 response (patient routes need no key):

```sh
# The llm-summary saved on the DynamoDB item, with "sum-id", expiresAt, daysLeft and availableLanguages
curl -s "http://localhost:4000/llm-sumary?sum-id=<sumId>"

# The same item on the correct spelling and with sum_id
curl -s "http://localhost:4000/llm-summary?sum_id=<sumId>"

# A well-formed id nobody issued: 404; no id: 400
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/llm-sumary?sum-id=AAAAAAAAAAAAAAAAAAAAAA"
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/llm-sumary"
```

To see day 30, stop the server and start it with the clock 31 days ahead and the purge timer off, then read the same `sumId` again: `410 link_expired`, decided at read time before anything is deleted. That summary stays expired after you restart normally, so ingest a fresh one for task 5.

```sh
DEMO_NOW=$(node -e 'console.log(new Date(Date.now()+31*864e5).toISOString())') PURGE_INTERVAL_MS=0 npm run dev
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/llm-sumary?sum-id=<sumId>"
```

While the LLM is still working the route answers `425 processing`; with the offline provider that window is a few milliseconds, so `npm test` holds the model on a gate to check it.

Checked on 2026-10-10 against `npm run dev` on this commit: 200 with the summary, identical bodies on both spellings, 404, 400, and 410 after the restart 31 days ahead. Checked live the same day: `GET /llm-sumary` on the task 3 live server returned the summary Bedrock wrote, read from the `discharge-summaries` item.

### Task 5: `GET /translation?lang=&sum_id=`

Use a fresh `sumId` from task 3 (ingested with `"language":"es"`):

```sh
# Spanish was produced at ingest because the provider picked it: "fromCache":true
curl -s "http://localhost:4000/translation?lang=es&sum_id=<sumId>"

# Mandarin is not on the item yet: the agent translates the llm-summary, the result is saved, "fromCache":false
curl -s "http://localhost:4000/translation?lang=zh&sum_id=<sumId>"

# Ask again (a language name works too): served from the item, "fromCache":true, availableLanguages ["en","es","zh"]
curl -s "http://localhost:4000/translation?lang=Mandarin&sum_id=<sumId>"

# No lang: 400; a language it cannot resolve: 400; an id nobody issued: 404
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/translation?sum_id=<sumId>"
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/translation?lang=klingon&sum_id=<sumId>"
curl -s -w ' HTTP %{http_code}\n' "http://localhost:4000/translation?lang=es&sum_id=AAAAAAAAAAAAAAAAAAAAAA"
```

With the default offline provider the cache behaves exactly as above, but the words are a stand-in: Spanish comes from a small phrase dictionary (so some English remains), and other languages come back in English marked `[zh]` and so on. Example 1 in `fixtures/` has full Spanish, Mandarin and Arabic fixtures. Real translations need `LLM_PROVIDER=bedrock`.

Checked on 2026-10-10 against `npm run dev` on this commit: Spanish `fromCache: true`, Mandarin `false` then `true`, `availableLanguages` `["en", "es", "zh"]`, 400, 400, 404. Checked live the same day on `us.anthropic.claude-sonnet-4-6` against the task 3 item: the first Mandarin request translated in 3.6 s (`fromCache: false`, "开始每天口服一次 Furosemide 40 mg。", name and dose verbatim), the second came from the item in 73 ms (`fromCache: true`), and boto3 showed `translations` on the `discharge-summaries` item holding `es` and `zh`. The two live test items and the test PDF were then deleted from `discharge-summaries` and `emrpdf-rh` by key and confirmed gone.

## The demo (what the judge sees)

`npm run demo` runs `scripts/demo.sh` against the server started with `npm run dev`:

1. `GET /health` shows the clock, where the configuration came from, and the active providers.
2. `GET /patients` returns the nine keys; the demo picks patient 1.
3. `POST /ingest` with Example 1 (the CHF discharge summary) as `{ data, type: "text", patientID, language: "Spanish" }` answers `202 "ingestion started"` with the `sumId` at once.
4. `GET /jobs/:id` goes `received -> simplifying -> stored -> emailing -> done`; the server terminal prints two emails, one to the patient and one to the caregiver, each with the link. The safety check reports 11 medications in the source, 11 in the output, nothing dropped, nothing unsupported.
5. `GET /llm-sumary?sum-id=` returns the plain-language JSON in English with `daysLeft: 30`, `expiresAt`, `availableLanguages: ["en", "es"]`.
6. `GET /translation?lang=es&sum_id=` returns Spanish from the item (`fromCache: true`): it was produced at ingest because the provider picked it.
7. `GET /translation?lang=zh&sum_id=` runs the translation agent once (`fromCache: false`); the second call is served from the item (`fromCache: true`). Medication names and doses are identical in every language.
8. `GET /p/:token?language=es` serves the same summary on the diagram's patient route.
9. `POST /synthesize { text, language: "ar" }` runs the AI pipeline directly and returns the JSON per language plus the safety result, storing nothing.
10. Day 30: `DEMO_NOW=<31 days ahead> npm run sweep` runs the purge against the same stores: the summary item is deleted (and the PDF or audio object when there is one), one deletion receipt each. With the clock shifted, the purge refuses to touch DynamoDB or S3 (it would delete teammates' recent data in the shared table), so run the demo on local stores; on the team account it stops at this step with that message.
11. `GET /llm-sumary`, `GET /translation` and `GET /p/:token` answer `410 link_purged`.
12. `npm run show-audit -- --receipts` and `npm run show-audit -- --link <sumId>` print the receipts and the summary's audit trail; no PHI appears in either.

Run on 2026-10-10 in the build container with the offline providers on SQLite: exit 0, every step as above.

## Public surface

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/health` | anyone | clock, configuration source, providers, PDF and audio stores with any fallback reason |
| GET | `/patients[?q=]` | provider | task 1 |
| GET | `/patients/:id` | provider | one patient, with the active link once generated |
| POST | `/patients` | provider | create a patient (seeding); takes the nine contract keys or camelCase |
| POST | `/ingest` | provider | task 3; multipart `patientId` + one of `text`, `file` (PDF), `audio` is kept as an alias (audio comes from the diagram) |
| GET | `/jobs/:jobId` | provider | follow the 202: stage, safety result, run metadata |
| POST | `/synthesize` | provider | `{ text, language?, languages? }` returns the JSON per language; `{ linkId }` (a sumId) re-runs the pipeline over the stored raw text and stores the result (diagram) |
| GET | `/llm-sumary?sum-id=` | patient | task 4; also `/llm-summary`, `?sum_id=` |
| GET | `/translation?lang=&sum_id=` | patient | task 5 |
| GET | `/p/:token[?language=]` | patient | the diagram's patient page on the same handler |
| GET | `/summary?link=`, `/translate?link=&language=` | patient | earlier spellings of tasks 4 and 5, kept as aliases |
| GET | `/docs`, `/openapi.json` | anyone | OpenAPI 3 |

The plain-language JSON (`contracts/ai-output.schema.json`, `contracts/ai-output.ts`), exactly these keys per language:

```
{ language, steps: [{ id, text }], medications: [{ name, dose, howOften, status: new|continue|stop, why }],
  followUps: [{ who, when, why }], warnings: [{ text, tier?: call911|er|clinic }] }
```

Safety-check results are stored separately and returned by `POST /synthesize` and `GET /jobs/:id`, never inside the per-language object.

## Where each piece lives

| Piece | Files |
| --- | --- |
| Light provider auth | `src/middleware/providerAuth.ts` (`x-provider-key`, constant-time compare) |
| `POST /ingest`, 202, async job | `src/routes/ingest.ts`, `src/pipeline/ingestJob.ts`, `src/pipeline/queue.ts` |
| PDF to text | `src/extract/pdfToText.ts` (`pdfToText`, pdf-parse with a pdfjs fallback), `src/extract/text.ts` |
| PDF and audio objects | `src/data/objects.ts` (S3 `emrpdf-rh` / `emraudio-rh` or local folders), `src/data/s3/objects.ts`, `scripts/setup-s3.ts` |
| The random path (`sumId`) | `src/crypto/sumId.ts` (128 random bits, base64url, 22 characters) |
| SQL: `patients`, `activeLinks`, `jobs`, `audit_log` | `src/db/migrations/0001_init.sql`, `src/db/repos/{patients,activeLinks,jobs,audit}.ts`, MariaDB via `src/db/index.ts` (`MySqlDb`), SQLite locally |
| DynamoDB `discharge-summaries`, one item per summary | `src/docstore/dynamo.ts`, SQL twin `src/docstore/local.ts`, item type `src/docstore/types.ts`, `scripts/setup-dynamo.ts` |
| Speech to text (Transcribe Medical) | `src/pipeline/speechToText.ts`, `src/pipeline/transcribe/medical.ts`, offline fixture `fixtures/offline/transcripts/dictation-1.json` |
| Plain language, Bedrock Claude at grade 5 | `src/pipeline/simplify.ts`, `src/pipeline/bedrock/{converse,simplify}.ts`, `src/pipeline/prompts.ts`, offline `src/pipeline/offline/{fixtures,rules}.ts` |
| Safety checks (never drop meds, doses, times) | `src/pipeline/safetyChecks.ts` (deterministic, both directions, plus the translation check) |
| Translation agent | `src/pipeline/translate.ts`, `src/pipeline/bedrock/translate.ts`, fixtures `fixtures/offline/ai-output/example-1.{es,zh,ar}.json` |
| Patient reads, cache-first translation | `src/routes/{llmSummary,translation,patientLink,summary,translate}.ts`, shared `src/routes/linkAccess.ts` |
| Email the patient and the caregiver (console, SMTP, SES, optional SQS + worker) | `src/email/{mailer,templates,queue}.ts`, `emailLinks` in `src/pipeline/ingestJob.ts`, `scripts/email-worker.ts` |
| Day 30: read-time expiry, purge, DynamoDB TTL, S3 lifecycle | `src/routes/linkAccess.ts` (410 at read time), `src/pipeline/purge.ts`, `scripts/sweep.ts` |
| Deletion receipts | `src/audit/receipts.ts` (sql, file, console, dynamo sinks), `src/audit/streamHandler.ts` (DynamoDB Streams, TTL REMOVE events), `src/audit/s3EventHandler.ts` (lifecycle expirations), `scripts/show-audit.ts` |
| Configuration from the team secret | `src/secrets.ts`, `src/bootstrap.ts` |

## Team infrastructure

Region `us-west-2`, account `183815333909`. All of it is wired in; the backend reads the secret at boot and uses the real resources whenever AWS credentials resolve.

- Secrets Manager secret `hackhealth/secret`, ARN `arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q`. Keys: `dynamodb-table` (`discharge-summaries`), `dynamodb-table-pk` (`uid`), `mysql-host`, `mysql-port` (3306), `mysql-user` (`admin`), `mysql-password`, `mysql-db` (`dischargeai`, the database to use; the tables are created inside it). The password and the database name come only from the secret at runtime; they are never in a file, a log, a test or this README. `/health` reports which variables came from the secret, by name.
- RDS instance `patients`: MariaDB, `db.t4g.micro`, endpoint `patients.cleqcmkoulma.us-west-2.rds.amazonaws.com`, port 3306, user `admin`, IAM authentication enabled, security group open on 3306. The AWS console's connection steps:
  1. `curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` (`npm run fetch-rds-bundle` runs exactly this into `certs/`; a copy of the public bundle is committed, identical to the one on `feature/infra-setup`).
  2. `mysql -h patients.cleqcmkoulma.us-west-2.rds.amazonaws.com -P 3306 -u admin -p"$(aws secretsmanager get-secret-value --secret-id 'arn:aws:secretsmanager:us-west-2:183815333909:secret:hackhealth/secret-ZWa02Q' --query SecretString --output text | jq -r '.["mysql-password"]')" --ssl-verify-server-cert --ssl-ca=./global-bundle.pem` (the console's own snippet reads the RDS-managed master secret with `jq -r '.password'` instead; both work, the password is never pasted).
  The backend does the same over `mysql2`: `ssl: { ca: readFileSync(RDS_CA_BUNDLE), rejectUnauthorized: true }`, a connection pool, `CREATE DATABASE IF NOT EXISTS dischargeai`, then the migrations. Either let the secret drive it, or set `DATABASE_URL=mysql://admin:<password>@patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306/dischargeai`. `npm run check-sql` connects, migrates and prints the server version and table counts.
- DynamoDB table `discharge-summaries`: hash key `uid` (string), no sort key, TTL enabled on `expiresAt` (epoch seconds). One item per summary: `uid` = `sumId`, `sum-id` (the same value), `patientID`, `raw-text`, `llm-summary` (the plain-language JSON in English), `translations` (a map keyed by language code), `language`, `status`, `createdAt`, `expiresAt`, plus the backend's own `inputKind`, `pdfKey`/`audioKey`, `safety` and `meta`. The attributes are plain so teammates can read them and their own LLM agent can write `llm-summary` into the same item; DynamoDB encrypts the table at rest. `npm run setup-dynamo` creates the table when missing and enables TTL, idempotently.
- S3 bucket `emrpdf-rh`: uploaded PDFs under `<sumId>.pdf` with SSE-S3 (AES256). `npm run setup-s3` creates it when missing and makes sure it blocks public access, encrypts by default and expires objects after 30 days (`-- --check` only reports; `-- --bucket <name>` limits it to one bucket).
- S3 bucket `emraudio-rh`: audio clips under `<sumId>.<ext>` with SSE-S3. It already carries the lifecycle rule `autodelete` (expire after 30 days, abort incomplete multipart uploads after 30 days), which `npm run setup-s3` leaves alone. If either bucket is unreachable at boot the backend falls back to the local folder and says so in `/health` (`providers.pdf.fallbackReason`, `providers.audio.fallbackReason`).

The `sumId` is stored as-is in `activeLinks`, as the DynamoDB `uid` and in the object keys, because the tasks doc has teammates join on it. It is also the patient's credential, so access to the table and the buckets stays limited to the team role.

IAM the backend needs: `secretsmanager:GetSecretValue` on the secret; `dynamodb:PutItem, GetItem, UpdateItem, DeleteItem, Scan` on the table plus `DescribeTable, DescribeTimeToLive, UpdateTimeToLive, CreateTable` for the setup script; `bedrock:InvokeModel` on `us.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-haiku-4-5-20251001-v1:0`; `s3:PutObject, GetObject, DeleteObject, ListBucket` on `emrpdf-rh` and `emraudio-rh` (plus `CreateBucket, PutPublicAccessBlock, PutEncryptionConfiguration, GetLifecycleConfiguration, PutLifecycleConfiguration` for the setup script); `ses:SendEmail` when `EMAIL_TRANSPORT=ses`; `sqs:SendMessage` (and `ReceiveMessage, DeleteMessage` for the worker) when `EMAIL_QUEUE=sqs`; `transcribe:StartMedicalTranscriptionJob, GetMedicalTranscriptionJob` when `SPEECH_PROVIDER=transcribe`; the Streams handler needs `dynamodb:DescribeStream, GetRecords, GetShardIterator, ListStreams`.

### Verified live from the build container (2026-10-10, Workshop Studio role)

| Check | Result |
| --- | --- |
| Secrets Manager `GetSecretValue` | all seven keys read and applied (406 ms); recorded in `fixtures/live-samples/infra.2026-10-10.json` |
| DynamoDB `discharge-summaries` | ACTIVE, hash key `uid`, TTL ENABLED on `expiresAt`; probe item put 84 ms, get 65 ms, delete 71 ms, gone after delete; `npm run setup-dynamo` reports no change needed |
| S3 `emraudio-rh` | HeadBucket ok; probe object put with SSE AES256 107 ms, get 89 ms, delete 81 ms; lifecycle rule `autodelete` 30 days present |
| Bedrock Converse | `us.anthropic.claude-sonnet-4-6` and `us.anthropic.claude-haiku-4-5-20251001-v1:0` both answer the tool-based JSON call |

These rows were recorded before the single-item layout and `emrpdf-rh`; the live runs on the new layout are recorded with each task under "Test the five tasks with curl".

### Needs a key or not exercised live from the build container

| Item | State |
| --- | --- |
| MySQL/MariaDB on RDS over port 3306 | implemented from the mysql2 API (pool, TLS with the RDS bundle, portable migrations, dialect rewrites) and tested through the shared SQL layer on SQLite; port 3306 is not reachable from the build container, so it is not exercised live. Run `npm run check-sql` from the EC2 host |
| Amazon SES (`EMAIL_TRANSPORT=ses`), SMTP | transports construct; no sending identity here, so emails print to the console |
| SQS email queue and `scripts/email-worker.ts` | producer and worker written; no queue URL here |
| Amazon Transcribe Medical (`SPEECH_PROVIDER=transcribe`) | adapter reads the clip from the bucket by key and polls the job; not run here (the offline fixture transcript is used) |
| DynamoDB Streams and S3 event Lambda handlers | exported handlers with tests on sample events; not deployed |
| Direct Anthropic API (`LLM_PROVIDER=anthropic`) | client written; no `ANTHROPIC_API_KEY` here |

## Configuration

Copy `.env.example` to `.env`. Everything has a local default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST`, `LOG_LEVEL` | `4000`, `0.0.0.0`, `info` | server |
| `PATIENT_APP_URL` | `http://localhost:5173` | links look like `${PATIENT_APP_URL}/s/<sumId>` |
| `PROVIDER_API_KEY` | `dev-provider-key` | the `x-provider-key` value |
| `DEMO_NOW` | unset | pins the app clock to an ISO moment at boot (day-30 demos); never in production |
| `PURGE_INTERVAL_MS` | `60000` | purge timer; `0` disables it (`npm run sweep` runs it once) |
| `DEMO_PURGE_ON_AWS` | `no` | with `DEMO_NOW` set, the purge refuses to run against DynamoDB or S3; `yes` allows it on a throwaway account only |
| `SECRETS_BOOTSTRAP`, `AWS_SECRET_ARN`, `AWS_REGION` | `auto`, the team ARN, `us-west-2` | read the secret at boot when credentials resolve; `off` never calls AWS |
| `DATABASE_URL` | unset | `sqlite:<file>` or `mysql://user:password@host:3306/db`; wins over everything |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, `MYSQL_POOL_SIZE` | from the secret, `dischargeai`, `5` | MariaDB; used when `DATABASE_URL` is unset and a host is known |
| `DATABASE_FILE` | `data/app.db` | SQLite when nothing else is set |
| `RDS_CA_BUNDLE` | `certs/global-bundle.pem` | AWS connection step 1 |
| `DOC_STORE`, `DYNAMO_TABLE`, `DYNAMO_PK`, `DYNAMO_ENDPOINT` | `auto`, `discharge-summaries`, `uid`, unset | `auto` means DynamoDB when the secret resolved, else the SQL twin; set the endpoint for DynamoDB Local |
| `PDF_STORE`, `PDF_BUCKET`, `PDF_DIR` | `auto`, `emrpdf-rh`, `data/pdf` | `auto` means S3 when the secret resolved and the bucket answers, else the local folder |
| `AUDIO_STORE`, `AUDIO_BUCKET`, `AUDIO_DIR` | `auto`, `emraudio-rh`, `data/audio` | same resolution for audio |
| `AUDIT_SINK`, `AUDIT_FILE` | `sql`, `data/audit/receipts.jsonl` | where deletion receipts go: the `audit_log` table, a JSONL file, the console, or `receipt#` items in the table |
| `LLM_PROVIDER`, `BEDROCK_MODEL_ID` | `offline`, `us.anthropic.claude-sonnet-4-6` | `bedrock` is the live provider; `anthropic` needs `ANTHROPIC_API_KEY` (`ANTHROPIC_MODEL` default `claude-opus-5-5`) |
| `SPEECH_PROVIDER`, `TRANSCRIBE_OUTPUT_BUCKET` | `offline`, unset | `transcribe` uses Transcribe Medical over the audio bucket |
| `EMAIL_TRANSPORT`, `EMAIL_FROM`, `SMTP_URL` | `console`, a placeholder, unset | console prints the message; `smtp`; `ses` |
| `EMAIL_QUEUE`, `SQS_QUEUE_URL` | `none`, unset | `sqs` enqueues instead of sending; `npm run email-worker` consumes |
| `MAX_UPLOAD_BYTES` | 15 MB | PDF and audio limit (a base64 PDF in JSON may be about 1.4 times that) |

Scripts: `dev`, `start`, `test`, `typecheck`, `demo`, `seed`, `sweep`, `show-audit`, `check-sql`, `fetch-rds-bundle`, `setup-dynamo`, `setup-s3`, `ensure-s3-lifecycle`, `verify-infra`, `live-ingest`, `email-worker`, `export-contract`, `make-fixture-pdf`. `docker-compose.yml` and `scripts/dynamodb-local.sh` run DynamoDB Local for `DOC_STORE=dynamo` without the team account.

## How the data lives and dies

SQL (SQLite locally, MariaDB on RDS): `patients` (first name, last name, date of birth, zip code, email, phone, caregiver email and name, preferred language), `activeLinks` (`id`, `sumId`, `patientID`, `createdAt`, `expiresAt = createdAt + 30 days`, `status`, plus the picked language, languages held, object keys, viewed-at and emailed-at), `jobs` (the stage machine, the safety result, metadata), `audit_log` (events and deletion receipts, never PHI). One portable schema; `src/db/migrate.ts` rewrites the few MySQL-specific tokens.

DynamoDB (or its SQL twin, the `summaries` table): one item per summary as described under "Team infrastructure".

Day 30 has four layers, from the fastest to the backstop:

1. Read time: every patient route compares `expiresAt` with the app clock and answers 410 before serving anything.
2. The purge job (`PURGE_INTERVAL_MS`, `npm run sweep`): deletes the summary item and the PDF or audio object with one deletion receipt each, marks the link purged.
3. DynamoDB TTL on `expiresAt` and the S3 lifecycle rules delete whatever is left on AWS; the Streams and S3 event handlers turn those deletions into the same receipts.
4. The backstop sweep inside the purge job deletes any expired item or 30-day-old object the per-link loop did not reach, with receipts.

Receipts say what was deleted (the item `uid` or the object key), when, by which mechanism (`purge_job`, `dynamodb_ttl`, `s3_lifecycle`, `local_sweeper`) and for which summary, and they outlive the data.

## Safety and what stays under human control

- The deterministic safety check runs after every model call: every medication the source names, with its dose, frequency and duration, must appear in the output, and nothing in the output may be absent from the source. A failure holds the summary as `needs_review` (423 for the patient, no email) until a clinician re-runs it through `POST /synthesize`. Translations are checked too: names and doses verbatim, every number preserved (a digit standing in for "once" or "twice" is accepted), the same ids, counts, statuses and tiers; a translation that fails is refused and not cached.
- The backend never writes anyone's words. It rephrases and translates the clinician's own discharge instructions for the patient and speaks as itself; it never drafts a message, note or reply for a person to send as their own.
- No PHI in logs (pino redaction; logs carry an 8-character hash of the sumId, never the id), in the audit log, in receipts, or in error bodies.
- The provider key is light auth for a hackathon front end; the patient credential is the 128-bit sumId, rate limited.

## What `alt-backend` adds

The other branch of this repo (`alt-backend`) keeps surfaces this branch leaves out, as its OpenAPI listed them on 2026-10-10: the patient checklist (`GET /checklist`, `POST /checklist/complete`), the demo clock and purge endpoints under `/admin/*`, `GET /languages`, `GET /audit` and `GET /audit/receipts`, `GET /contracts`, extra keys on each step such as `category` and `due`, and per-link encryption keys destroyed at expiry. This branch folds the language list into OpenAPI, moves the demo clock to `DEMO_NOW` plus `npm run sweep`, and prints the audit log with `npm run show-audit`.

## Tests

`npm test`: 108 passing of 108, 18 files, offline (`LLM_PROVIDER=offline`, SQLite in memory), on Node 24.21.0 and Node 22.22.0. Coverage: patients and the nine contract keys, provider auth and the surface, JSON ingest of text and base64 PDF, the 400 on a bad `type`, multipart ingest of text, PDF and audio, the `activeLinks` row, the DynamoDB item with `sum-id` and `llm-summary`, the email to the patient and the caregiver, needs_review on a dropped medication, cache-first translation on `GET /translation` (miss, then hit by code and by name, the agent given exactly the `llm-summary`, the result saved under `translations[lang]`) and on the earlier `/translate` with Spanish, Mandarin and Arabic, a refused translation that is not cached, `GET /llm-sumary` found, aliases, 400, 404, 425 and 410, every mounted route documented in OpenAPI, the DEMO_NOW purge refusing AWS stores, `GET /p/:token`, `POST /synthesize` in both modes, read-time 410, purge with receipts and object deletion, DEMO_NOW, the SQL dialect rewrites and `DATABASE_URL` parsing, the Secrets Manager bootstrap with an injected fetcher, the DynamoDB store on a fake table, the S3 store on a fake bucket, the lifecycle merge, the stream and S3 event handlers, the safety checks on all five examples, the contract and fixtures, and the OpenAPI document against the mounted routes.

## Limitations

The MariaDB path is written against the mysql2 API and tested on SQLite, not against RDS from here (see the table above). Per-patient listing in DynamoDB is a filtered scan. The simplifier and translator prompts are starting points for the teammate who owns them; the contract and the safety check are what the rest of the system relies on. Audio transcription runs on the offline fixture unless Transcribe Medical is enabled.
