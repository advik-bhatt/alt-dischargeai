-- Patients move to the team's table `patientinfo` (read-only for this backend; GET /patients reads it).
-- SQLite (local development and tests): create an empty `patientinfo` with the tasks doc's column names
-- when the file has none, and rebuild activeLinks without the foreign key to the old `patients` table
-- (a database migrated by the earlier 0001 has it, and foreign keys are enforced here). The old
-- `patients` table, if any, is left untouched and unused.
PRAGMA foreign_keys = OFF;
-- A previous run that stopped half way (SQLite DDL here is not transactional) leaves this scratch table.
DROP TABLE IF EXISTS activeLinks_rebuild;
CREATE TABLE activeLinks_rebuild (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sumId VARCHAR(32) NOT NULL,
  patientID VARCHAR(64) NOT NULL,
  createdAt VARCHAR(32) NOT NULL,
  expiresAt VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  language VARCHAR(16) NOT NULL DEFAULT 'en',
  languages VARCHAR(512) NOT NULL DEFAULT '["en"]',
  pdfKey VARCHAR(80),
  audioKey VARCHAR(80),
  lastViewedAt VARCHAR(32),
  emailedAt VARCHAR(32),
  CONSTRAINT uq_activeLinks_sumId UNIQUE (sumId),
  CONSTRAINT ck_activeLinks_status CHECK (status IN ('pending', 'ready', 'needs_review', 'failed', 'expired', 'purged'))
);
INSERT INTO activeLinks_rebuild (id, sumId, patientID, createdAt, expiresAt, status, language, languages, pdfKey, audioKey, lastViewedAt, emailedAt)
  SELECT id, sumId, patientID, createdAt, expiresAt, status, language, languages, pdfKey, audioKey, lastViewedAt, emailedAt FROM activeLinks;
DROP TABLE activeLinks;
ALTER TABLE activeLinks_rebuild RENAME TO activeLinks;
CREATE INDEX IF NOT EXISTS activeLinks_expiresAt ON activeLinks (expiresAt);
CREATE INDEX IF NOT EXISTS activeLinks_patientID ON activeLinks (patientID);
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS patientinfo (
  ID VARCHAR(64) PRIMARY KEY,
  DOB VARCHAR(10),
  FirstName VARCHAR(120),
  LastName VARCHAR(120),
  ZipCode VARCHAR(16),
  email VARCHAR(254),
  phoneNumber VARCHAR(32),
  caregiverEmail VARCHAR(254),
  caregiverName VARCHAR(160),
  preferredLanguage VARCHAR(16)
);
