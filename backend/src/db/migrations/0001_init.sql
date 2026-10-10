-- DischargeAI backend schema. Portable SQL that runs unchanged on SQLite (local, tests) and on
-- MariaDB/MySQL (the team's RDS instance): VARCHAR for keyed columns, TEXT for JSON blobs, BLOB for
-- ciphertext and keys, INTEGER for counters. src/db/migrate.ts rewrites the few dialect-specific
-- tokens (AUTOINCREMENT, BLOB/TEXT sizes) for MySQL. Timestamps are ISO-8601 strings produced by
-- the app clock, never by the database, so expiry is computed in one place.

-- The note's SQL patient table: first name, last name, date of birth, zip code, email, phone, and the
-- active link once the ingester generates it.
CREATE TABLE IF NOT EXISTS patients (
  id VARCHAR(64) PRIMARY KEY,
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120) NOT NULL,
  date_of_birth VARCHAR(10) NOT NULL,
  zip_code VARCHAR(16) NOT NULL,
  email VARCHAR(254) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  preferred_language VARCHAR(16),
  active_link_id VARCHAR(32),
  active_link_expires_at VARCHAR(32),
  created_at VARCHAR(32) NOT NULL
);

-- One row per patient link. Only sha256(linkId) is stored; the raw id lives in the 202 response, the
-- email and patients.active_link_id (cleared at purge). enc_key is the per-link AES-256-GCM data key;
-- purge sets it to NULL (crypto-shredding) so a lagging DynamoDB TTL delete is already unreadable.
-- language = the language the provider picked at ingest; languages = JSON array of the languages the
-- document store currently holds for this link (English first).
CREATE TABLE IF NOT EXISTS links (
  link_id_hash VARCHAR(64) PRIMARY KEY,
  patient_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  enc_key BLOB,
  language VARCHAR(16) NOT NULL DEFAULT 'en',
  languages VARCHAR(512) NOT NULL DEFAULT '["en"]',
  audio_key VARCHAR(80),
  last_viewed_at VARCHAR(32),
  emailed_at VARCHAR(32),
  CONSTRAINT fk_links_patient FOREIGN KEY (patient_id) REFERENCES patients (id),
  CONSTRAINT ck_links_status CHECK (status IN ('pending', 'ready', 'needs_review', 'failed', 'expired', 'purged'))
);
CREATE INDEX IF NOT EXISTS links_expires_at ON links (expires_at);
CREATE INDEX IF NOT EXISTS links_patient_id ON links (patient_id);

-- The ingest pipeline, persisted so the 202 can be followed and a restart does not lose a job.
-- safety = JSON of the deterministic safety-check result (counts, names and doses; no patient data).
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  link_id_hash VARCHAR(64) NOT NULL,
  stage VARCHAR(16) NOT NULL,
  input_kind VARCHAR(8) NOT NULL,
  error VARCHAR(512),
  safety TEXT,
  meta TEXT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_jobs_link FOREIGN KEY (link_id_hash) REFERENCES links (link_id_hash)
);
CREATE INDEX IF NOT EXISTS jobs_link ON jobs (link_id_hash);
CREATE INDEX IF NOT EXISTS jobs_stage ON jobs (stage);

-- Event trail and deletion receipts. details is JSON and never carries PHI.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event VARCHAR(40) NOT NULL,
  link_id_hash VARCHAR(64),
  actor VARCHAR(16) NOT NULL,
  at VARCHAR(32) NOT NULL,
  details TEXT,
  CONSTRAINT ck_audit_actor CHECK (actor IN ('provider', 'patient', 'system'))
);
CREATE INDEX IF NOT EXISTS audit_link ON audit_log (link_id_hash);
CREATE INDEX IF NOT EXISTS audit_event ON audit_log (event);

-- LocalDocumentStore: the SQL twin of the DynamoDB table (same item shape, expires_at = TTL attribute).
CREATE TABLE IF NOT EXISTS documents (
  pk VARCHAR(80) NOT NULL,
  sk VARCHAR(40) NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (pk, sk)
);
CREATE INDEX IF NOT EXISTS documents_expires_at ON documents (expires_at);
