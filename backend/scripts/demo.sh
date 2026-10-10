#!/bin/sh
# DischargeAI demo against a running backend (default: offline providers, no keys needed), on the
# team's backend tasks doc routes:
#   npm run dev            (in another terminal, from backend/)
#   npm run seed           (once, on a local SQLite file: six synthetic patients; never on MySQL)
#   npm run demo           (this script, from backend/ or anywhere)
# Story: GET /patients -> POST /ingest {data,type:"text",patientID,language} for Example 1 (CHF) in
#        Spanish -> 202 "ingestion started" with the sumId -> the server prints the email to the patient
#        and the caregiver -> GET /llm-sumary?sum-id= -> GET /translation?lang=es (made at ingest, from
#        the store) -> GET /translation?lang=zh twice (agent once, then the cache) -> GET /p/:token ->
#        POST /synthesize ar -> the sweeper with DEMO_NOW 31 days ahead -> 410 -> the deletion receipts.
# The sweep step runs in this shell with the same .env / Secrets Manager configuration as the server,
# so start the server from backend/ (SQLite file data/app.db, local twins under data/) or point both at
# the team account. Override BASE_URL / PROVIDER_API_KEY / PATIENT_ID / INPUT / LANGUAGE as needed.
set -eu

BASE_URL="${BASE_URL:-http://localhost:${PORT:-4000}}"
KEY="${PROVIDER_API_KEY:-dev-provider-key}"
INPUT="${INPUT:-fixtures/discharge-summaries/example-1-chf.txt}"
LANGUAGE="${LANGUAGE:-Spanish}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(typeof v==="string"?v:JSON.stringify(v,null,1))})' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
status() { curl -sS -o /dev/null -w '%{http_code}' "$1"; }
meds() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);for(const m of v.medications.slice(0,Number(process.argv[2])))console.log("  ",m.status.padEnd(8),m.name,m.dose,"|",m.howOften)})' "$1" "$2"; }

step "1. Health: clock, configuration source, providers"
curl -sS "$BASE_URL/health" | json providers
echo "config source: $(curl -sS "$BASE_URL/health" | json config.source)"

step "2. GET /patients (provider key): ID, DOB, FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName"
PATIENTS=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/patients")
[ "$(printf '%s' "$PATIENTS" | json patients.length)" != "0" ] || { echo "GET /patients is empty: the patients table (patientinfo) has no rows. On a local SQLite file run 'npm run seed' once, then run the demo again."; exit 1; }
PATIENT_ID="${PATIENT_ID:-$(printf '%s' "$PATIENTS" | json patients.0.ID)}"
printf '%s' "$PATIENTS" | json patients.0
echo "patientID=$PATIENT_ID"

step "3. POST /ingest {data, type, patientID, language: $LANGUAGE} -> 202 'ingestion started'"
if [ "${INPUT##*.}" = "pdf" ]; then TYPE=pdf; else TYPE=text; fi
BODY=$(node -e 'const fs=require("fs");const [f,t,p,l]=process.argv.slice(1);const b=fs.readFileSync(f);console.log(JSON.stringify({data:t==="pdf"?b.toString("base64"):b.toString("utf8"),type:t,patientID:p,language:l}))' "$INPUT" "$TYPE" "$PATIENT_ID" "$LANGUAGE")
ACCEPTED=$(printf '%s' "$BODY" | curl -sS -H "x-provider-key: $KEY" -H 'content-type: application/json' --data-binary @- "$BASE_URL/ingest")
echo "$ACCEPTED"
JOB_ID=$(printf '%s' "$ACCEPTED" | json jobId)
SUM_ID=$(printf '%s' "$ACCEPTED" | json sumId)
EXPIRES_AT=$(printf '%s' "$ACCEPTED" | json expiresAt)
[ -n "$SUM_ID" ] && [ "$SUM_ID" != "undefined" ] || { echo "ingest failed"; exit 1; }

step "4. Follow the job (GET /jobs/:id) until done; the server terminal prints the email to the patient and the caregiver"
for i in $(seq 1 180); do
  JOB=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/jobs/$JOB_ID")
  STAGE=$(printf '%s' "$JOB" | json stage)
  echo "  stage=$STAGE"
  case "$STAGE" in done|needs_review|failed) break ;; esac
  sleep 1
done
echo "verified=$(printf '%s' "$JOB" | json verified) languages=$(printf '%s' "$JOB" | json languages) provider=$(printf '%s' "$JOB" | json meta.provider) model=$(printf '%s' "$JOB" | json meta.model)"
echo "safety: source meds=$(printf '%s' "$JOB" | json safety.sourceMedicationCount) output meds=$(printf '%s' "$JOB" | json safety.outputMedicationCount) dropped=$(printf '%s' "$JOB" | json safety.dropped) unsupported=$(printf '%s' "$JOB" | json safety.unsupported)"
[ "$STAGE" = "done" ] || { echo "job ended in $STAGE"; [ "$STAGE" = "failed" ] && exit 1; }

step "5. GET /llm-sumary?sum-id= : the LLM summary saved on the DynamoDB item"
SUMMARY=$(curl -sS "$BASE_URL/llm-sumary?sum-id=$SUM_ID")
echo "steps:"; printf '%s' "$SUMMARY" | json llm-summary.steps
echo "medications (status, name, dose | how often):"; printf '%s' "$SUMMARY" | meds llm-summary 20
echo "daysLeft=$(printf '%s' "$SUMMARY" | json daysLeft) expiresAt=$(printf '%s' "$SUMMARY" | json expiresAt) availableLanguages=$(printf '%s' "$SUMMARY" | json availableLanguages)"

step "6. GET /translation?lang=es&sum_id= : made at ingest because the provider picked $LANGUAGE, so it comes from the store"
ES=$(curl -sS "$BASE_URL/translation?lang=es&sum_id=$SUM_ID")
printf '%s' "$ES" | json translation.steps.0
echo "fromCache=$(printf '%s' "$ES" | json fromCache) lang=$(printf '%s' "$ES" | json lang)"

step "7. GET /translation?lang=zh twice: the translation agent runs once, then the cache answers"
ZH1=$(curl -sS "$BASE_URL/translation?lang=zh&sum_id=$SUM_ID")
printf '%s' "$ZH1" | json translation.steps.0
echo "first call fromCache=$(printf '%s' "$ZH1" | json fromCache)"
ZH2=$(curl -sS "$BASE_URL/translation?lang=Mandarin&sum_id=$SUM_ID")
echo "second call fromCache=$(printf '%s' "$ZH2" | json fromCache) availableLanguages=$(printf '%s' "$ZH2" | json availableLanguages)"
echo "medication names and doses stay verbatim:"; printf '%s' "$ZH2" | meds translation 4

step "8. The patient page (GET /p/:token, the diagram's route) on the same sumId"
VIEW=$(curl -sS "$BASE_URL/p/$SUM_ID?language=es")
echo "language=$(printf '%s' "$VIEW" | json language) fromCache=$(printf '%s' "$VIEW" | json fromCache) daysLeft=$(printf '%s' "$VIEW" | json daysLeft)"

step "9. Lane 3 directly (POST /synthesize { text, language: ar }): the JSON per language plus the safety result, nothing stored"
SYN=$(node -e 'const fs=require("fs");console.log(JSON.stringify({text:fs.readFileSync(process.argv[1],"utf8"),language:"ar"}))' "fixtures/discharge-summaries/example-1-chf.txt" | curl -sS -H "x-provider-key: $KEY" -H 'content-type: application/json' --data-binary @- "$BASE_URL/synthesize")
echo "languages=$(printf '%s' "$SYN" | json languages) verified=$(printf '%s' "$SYN" | json verified) stored=$(printf '%s' "$SYN" | json stored)"
printf '%s' "$SYN" | json perLanguage.ar.steps.0

step "10. Day 30: the sweeper runs with DEMO_NOW 31 days ahead against the same stores (summary item and objects deleted, receipts written)"
DEMO_NOW=$(node -e 'console.log(new Date(Date.now()+31*864e5).toISOString())')
echo "DEMO_NOW=$DEMO_NOW (the link expires at $EXPIRES_AT)"
DEMO_NOW="$DEMO_NOW" npx tsx scripts/sweep.ts

step "11. The summary is gone: GET /llm-sumary, GET /translation and GET /p/:token answer 410"
curl -sS "$BASE_URL/llm-sumary?sum-id=$SUM_ID"; echo " (HTTP $(status "$BASE_URL/llm-sumary?sum-id=$SUM_ID"))"
echo "HTTP $(status "$BASE_URL/translation?lang=es&sum_id=$SUM_ID") for /translation, HTTP $(status "$BASE_URL/p/$SUM_ID") for /p/:token"

step "12. Deletion receipts and the summary's audit trail (no PHI anywhere in them)"
npx tsx scripts/show-audit.ts --receipts
npx tsx scripts/show-audit.ts --link "$SUM_ID"
echo
echo "demo complete"
