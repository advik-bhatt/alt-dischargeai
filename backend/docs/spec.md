# DischargeAI backend: requirements (Kiro spec)

Scope: everything under `backend/` on branch `backend` of `sameerj05/DischargeAI`. The backend owns the SQL patient database, every API endpoint, and the document-store (DynamoDB) read/write logic. Teammates own the plain-language simplification prompt and the translation agent; the backend ships a working default for both behind an interface so the whole product demos end to end today.

Challenge brief (Rutgers Health Hack 2026, Ops Unleashed, Challenge 1 "Discharge AI"): capture complex clinical discharge instructions (audio or EMR text), turn them into plain language and the patient's native tongue, host them at a secure link, and permanently self-destruct the data exactly 30 days after creation. Judged on clinical-to-vernacular translation, technical architecture and compliance (audio/text recorded, 30-day self-destruct fully functional in database code), and user experience.

## Glossary

- Provider: nurse or clinician using the provider app. Authenticated with the `x-provider-key` header.
- Patient: the person the discharge summary is about. Authenticated only by the unguessable 128-bit link id.
- Caregiver: an optional second recipient who receives the same link only after the patient approves.
- Link: one discharge summary, addressed by `linkId`. The server stores only `sha256(linkId)`.
- Document store: the DynamoDB table (or its SQLite stand-in) holding encrypted raw text, simplified JSON, and translations, each with a TTL attribute.

## User stories and acceptance criteria

### US-1 Provider picks a patient
As a provider, I want to list and search patients so I can attach a discharge summary to the right person.

- GET `/patients` returns the seeded 6 synthetic patients; `?q=` filters by first name, last name, email or phone (case-insensitive substring).
- POST `/patients` creates a patient from `{firstName, lastName, dateOfBirth, zipCode, email, phone}`; invalid bodies return 400 with zod issues.
- Both require `x-provider-key`; a missing or wrong key returns 401.
- Every patient row shows `activeLinkId` (null when none) and `activeLinkExpiresAt`.

### US-2 Provider ingests a discharge summary (text, PDF or audio)
As a provider, I want to paste text, upload a PDF, or dictate audio and get back a patient link immediately.

- POST `/ingest` is multipart: `patientId` (required) plus exactly one of `text`, `file` (PDF) or `audio` (wav/mp3/m4a/webm). Optional `language` (patient preference), `caregiverEmail`, `caregiverApproved` (boolean).
- Empty input (no text, empty PDF, no audio) returns 400 `{ error: "empty_input" }`.
- Success returns 202 `{ jobId, linkId, link: "${PATIENT_APP_URL}/s/${linkId}", expiresAt, statusUrl: "/jobs/${jobId}" }` before any LLM call runs.
- The pipeline runs asynchronously: extract text (pdf-parse, with pdfjs-dist fallback; TranscriberAgent for audio) -> SimplifierAgent -> fidelity check -> encrypt and store raw + simplified -> set `patients.active_link_id` -> email the patient (and caregiver only when `caregiverApproved=true`) -> audit.
- The pipeline is persisted in the SQL `jobs` table so a restart does not lose a job; stages: `received | extracting | transcribing | simplifying | stored | emailing | done | failed | needs_review`.
- GET `/jobs/:jobId` (provider) returns `{ jobId, stage, error, warnings, createdAt, updatedAt, linkIdHash }`.

### US-3 Patient reads the plain-language summary
As a patient, I want to open my link and see what to do in simple words, with the expiry stated upfront.

- GET `/summary?link=<linkId>` returns the simplified JSON (shape below) plus `{ expiresAt, daysLeft, warnings, checklistState }`.
- 404 for an unknown link, 410 for expired or purged, 425 `{ stage }` while the job is still running.
- Expiry is checked at read time against the app clock, independently of the purge job.
- Every medication name, dose and frequency in the simplified JSON appears verbatim in the source text (deterministic fidelity check). Misses are listed in `warnings[]` and the job is flagged `needs_review` rather than silently shipped.

Simplified summary shape (validated with zod):

```
{ readingLevel: "grade5", language: "en", summary: string (3-5 short sentences),
  diagnoses: [{ plain, clinical }],
  medications: { new: [{ name, dose, howOften, why, startDate? }], continue: [...], stop: [{ name, why }] },
  checklist: [{ id, type: med|appointment|referral|vital|lab|lifestyle, text, due? }],
  returnPrecautions: { call911: [string], goToER: [string], callClinic: [string] },
  followUps: [{ who, when, why }], questionsToAsk: [string] }
```

### US-4 Patient translates on demand
As a patient, I want one tap to see the summary in my language, with my medication names and doses untouched.

- GET `/translate?link=<linkId>&language=<name or ISO code>` returns the translated structured JSON; the first call runs the TranslatorAgent and caches, the second call is served from the document store (`fromCache: true`).
- Medication names, doses and frequencies are copied verbatim, never translated. The agent back-translates to English and diff-checks numbers and drug names; mismatches become `warnings[]`.
- GET `/languages` lists supported languages (name, code). Same 404/410/425 rules as `/summary`.

### US-5 Patient checks off the to-do list (advisors' request)
As a patient, I want to tick off medications, appointments and vital checks as I do them.

- POST `/checklist/complete` body `{ link, itemId, completed }` persists the state (keyed by link hash + itemId) and returns the full checklist state. Unknown `itemId` returns 404.
- GET `/summary` includes `checklistState` so the UI can render the ticks.

### US-6 Data self-destructs at exactly 30 days (hard rule)
As a compliance officer, I need every link and its data to be unreadable 30 days after creation, provably.

- `links.expires_at = created_at + 30 days` exactly; every document-store item carries `expiresAt` (epoch seconds) for DynamoDB TTL.
- Every stored payload is encrypted with a per-link AES-256-GCM data key stored in `links.enc_key`. The purge job destroys the key (crypto-shredding), deletes the document-store items, marks the link `purged`, clears `patients.active_link_id`, and writes an audit event.
- The purge job runs every `PURGE_INTERVAL_MS` and on POST `/admin/purge` (DEMO_MODE only). Reads check expiry independently, so a lagging TTL or purge never exposes data.
- POST `/admin/clock/advance { days }` (DEMO_MODE only) shifts the app clock so the judge can watch day 30 arrive.
- Test: advance 30 days -> `/summary` returns 410; purge -> key is null, document items are gone, and the stored ciphertext cannot be decrypted with any remaining material.

### US-7 Provider audits what happened
As a provider, I want to see the event trail for a link without seeing PHI.

- GET `/audit?link=<linkId>` (provider) returns `audit_log` rows `{ event, actor, at, details }` for that link's hash. `details` never contains PHI (no text, no names, no emails).
- Events: `link.created, job.stage, email.sent, email.queued, summary.viewed, translation.created, translation.viewed, checklist.updated, link.expired, link.purged, key.destroyed`.

### US-8 Email delivery with a real cloud path and a demo path
As a provider, I want the patient to receive the link by email, and as a demo runner I want to see that email without an SMTP account.

- `EMAIL_TRANSPORT=console` (default) prints the full message and link to stdout; `smtp` uses `SMTP_URL`; `ses` uses nodemailer's SES transport with `@aws-sdk/client-sesv2`.
- `EMAIL_QUEUE=sqs` enqueues `{ to, subject, text, linkIdHash }` to `SQS_QUEUE_URL` instead of sending; `scripts/email-worker.ts` consumes and sends, and also exports a Lambda `handler`.
- The email body never contains the summary itself, only the link and the expiry date.

### US-9 Document store runs locally or on DynamoDB
As the backend owner, I want DynamoDB to be first-class but never required for a demo.

- `DOC_STORE=local` (default) uses a SQLite `documents` table with the same `{pk, sk, ciphertext, iv, tag, keyVersion, expiresAt}` shape.
- `DOC_STORE=dynamo` uses `@aws-sdk/lib-dynamodb` against `DYNAMO_TABLE`, with `DYNAMO_ENDPOINT` for DynamoDB Local. `scripts/create-dynamo-table.ts` creates the table (pk HASH, sk RANGE) and enables TTL on `expiresAt`. `docker-compose.yml` runs `amazon/dynamodb-local`.

### US-10 Every AI call has an offline twin
As a tester, I want the full suite and the full demo to run with no keys.

- `LLM_PROVIDER=bedrock|anthropic|offline`, `TRANSCRIBE_PROVIDER=aws|offline`. Tests default to offline.
- The offline SimplifierAgent returns curated fixtures for the five example summaries (matched by fingerprint) and a rule-based extraction for anything else. The offline TranslatorAgent uses a small phrase dictionary for Spanish and a marked passthrough for other languages, keeping medications verbatim.
- The default live SimplifierAgent is Amazon Bedrock Converse with tool-based JSON (`BEDROCK_MODEL_ID`, default `us.anthropic.claude-sonnet-4-6`). Example 1 (CHF) is ingested through it at least once and the output stored under `backend/fixtures/live-samples/` with the model id and date.

### US-11 Team integration contract
As a teammate, I want to drop in my own simplifier or translator by replacing one file.

- `backend/src/agents/simplifier.ts` exports `interface SimplifierAgent { simplify(input: { text: string; language?: string }): Promise<SimplifiedSummary> }` and a factory keyed by `LLM_PROVIDER`.
- `backend/src/agents/translator.ts` exports `interface TranslatorAgent { translate(input: { summary: SimplifiedSummary; language: string }): Promise<TranslatedSummary> }`.
- README documents: implement the interface, export it from `src/agents/custom/<name>.ts`, register it in the factory, set the env var.

### US-12 Docs and demo
- OpenAPI 3 spec at `backend/openapi.yaml`, served at `/docs` (swagger-ui-express) and `/openapi.json`.
- `backend/README.md`: run in 3 commands, env table, endpoint table with curl, agent contract, demo narrative, "needs a key" table, "what stays under human control".
- `scripts/demo.sh` runs the narrative against a running server with offline providers: ingest Example 1 -> email printed -> GET /summary -> GET /translate?language=Spanish -> advance clock 30 days -> 410 -> purge log.

## Non-functional requirements

- No PHI in logs: pino with redaction of bodies, emails, text fields and the provider key; request logs carry only method, path, status, latency and link hash prefix.
- Node 22, TypeScript (ESM, NodeNext), Express 5, zod 4, better-sqlite3 by default, Postgres via `DATABASE_URL`.
- Tests: vitest, offline providers, the nine scenarios in the spec, counts recorded in README.
- Product law: the backend never emits text a user sends as their own. It explains and translates the clinician's instructions and speaks as itself.
- Copy: confident present tense, no product-history narration, no em dashes.
