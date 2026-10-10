# DischargeAI backend: requirements (Kiro spec)

Scope: everything under `backend/` on branch `backend` of `sameerj05/DischargeAI`. The backend owns the SQL patient database, every API endpoint, and the document-store (DynamoDB) read/write logic; teammates own the simplification prompt and the translation agent and plug in behind interfaces that ship with working defaults.

Precedence: Advik's Granola note is the source of truth; the team architecture diagram fills the gaps; the real AWS resources override names in both. The public surface is exactly the note plus the diagram.

Challenge brief (Rutgers Health Hack 2026, Ops Unleashed, "Discharge AI"): capture complex clinical discharge instructions (audio or EMR text), turn them into plain language and the patient's native tongue, host them at a secure link, and permanently self-destruct the data exactly 30 days after creation.

## Glossary

- Provider: nurse or clinician using the provider app; authenticated with `x-provider-key`.
- Patient: the person the discharge summary is about; authenticated only by the unguessable 128-bit link id (the token).
- Link: one discharge summary. The server stores only `sha256(linkId)`.
- Document store: DynamoDB `discharge-summaries` (hash key `uid`, TTL `expiresAt`) or its SQL twin, holding encrypted raw text, the LLM response and translations.
- Fixed JSON: `{ language, steps, medications, followUps, warnings }`, the contract per language.

## User stories and acceptance criteria

### US-1 Provider picks a patient (note)
- `GET /patients` returns the full list (`?q=` filters by name, email, phone); `GET /patients/:id`; `POST /patients` creates one. The SQL table holds first name, last name, date of birth, zip code, email, phone, preferred language, and the active link once generated. 401 without the key.

### US-2 Provider ingests a discharge summary (note, audio from the diagram)
- `POST /ingest` multipart: `patientId`, exactly one of `text`, `file` (PDF), `audio`, plus `language` (BCP-47 or name; default the patient's preference, then English).
- Stores the raw content, generates the random link id, answers `202 { status: "ingestion started", jobId, linkId, link, language, expiresAt, statusUrl }` before any model call.
- Asynchronously: PDF to text or audio to text; simplify at a 5th-grade level into the fixed JSON; deterministic safety checks; translate into the picked language; store raw text, LLM response and translation encrypted with `expiresAt = now + 30 days`; email "Your discharge summary is ready at this link"; audio clips land in the audio bucket under the link hash.
- `GET /jobs/:jobId` returns the stage, the safety result and run metadata, no patient text.
- A summary that fails the safety checks is held as `needs_review` and no email is sent.

### US-3 Patient reads the summary (note, token path from the diagram)
- `GET /summary?link=` and `GET /p/:token` return the fixed JSON plus `{ expiresAt, daysLeft, availableLanguages, fromCache }`.
- 400 malformed, 404 unknown, 410 expired or purged (checked at read time against the app clock), 425 while processing, 423 held for review.

### US-4 Patient translates on demand (note)
- `GET /translate?link=&language=` (and `?language=` on the two endpoints above) checks the document store first and serves the cached translation; on a miss it calls the translation agent once, checks the result (names, doses and numbers verbatim; same structure), stores it under the link's expiry, and returns it with `fromCache: false`. Any BCP-47 code or language name the model supports; Spanish, Mandarin and Arabic tested offline. A translation that fails the check answers 422 and is not cached.

### US-5 Provider runs the AI pipeline directly (diagram)
- `POST /synthesize { text, language?, languages? }` returns the fixed JSON per language and the safety result without storing anything.
- `POST /synthesize { linkId, language?, languages? }` re-runs the pipeline over the stored raw text, replaces the stored languages, drops stale translations, sets the status and emails the patient once it verifies.

### US-6 Data self-destructs at 30 days (hard rule)
- `links.expires_at = created_at + 30 days`; every document-store item carries `expiresAt` (epoch seconds) for DynamoDB TTL; audio objects are covered by the bucket's 30-day lifecycle rule.
- Every stored payload is encrypted with a per-link AES-256-GCM key. The purge job destroys the key, deletes the items and the audio object with one deletion receipt each, marks the link purged, clears the patient's active link. Reads check expiry independently.
- `DEMO_NOW` pins the app clock for a demo; `npm run sweep` runs the purge once. No HTTP endpoint moves the clock.
- The DynamoDB Streams handler and the S3 event handler write the same receipts for TTL and lifecycle deletions.

### US-7 Audit log of deletion receipts (diagram)
- Receipts say what was deleted (`uid` or object key), when, by which mechanism and for which link hash, never content. `npm run show-audit -- --receipts` prints them; `--link <linkId>` prints a link's trail.

### US-8 Team infrastructure (real resources)
- Configuration bootstraps from Secrets Manager `hackhealth/secret` (MariaDB host, port, user, password, database; DynamoDB table and key names); environment variables override; with no credentials the app runs fully local.
- SQL: MariaDB on RDS through `mysql2` with TLS against the public RDS bundle; SQLite for local work and tests; one portable schema.
- Document store: DynamoDB `discharge-summaries`, hash key `uid`, TTL `expiresAt`; `npm run setup-dynamo` is idempotent.
- Audio: S3 `emraudio-rh` with SSE; the existing lifecycle rule is verified, never duplicated; local fallback reported by `/health`.

### US-9 Every AI call has an offline twin
- `LLM_PROVIDER=offline|bedrock|anthropic`, `SPEECH_PROVIDER=offline|transcribe`. Tests and the demo run with no keys. Bedrock is exercised live and recorded with the model id and date.

### US-10 Docs and demo
- OpenAPI 3 at `/docs` and `/openapi.json`, pinned to the mounted routes by a test.
- README: precedence, lane-by-lane table, team infrastructure, run in one command, demo narrative, env table, needs-a-key table, what `alt-backend` adds.
- `scripts/demo.sh` runs the narrative end to end with the offline providers.

## Non-functional requirements

- No PHI in logs, audit rows, receipts, URLs or error bodies.
- Node 22, TypeScript (ESM, NodeNext), Express 5, zod 4, better-sqlite3, mysql2, AWS SDK v3.
- Tests: vitest, offline; counts recorded in the README.
- Product law: the backend never emits text a person sends as their own. It explains and translates the clinician's instructions and speaks as itself.
- Copy: confident present tense, no product-history narration, no em dashes.
