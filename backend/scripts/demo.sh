#!/bin/sh
# DischargeAI demo narrative against a running backend (default: offline providers, no keys needed).
#   npm run dev            (in another terminal, from backend/)
#   npm run demo           (this script, from backend/ or anywhere)
# Story: ingest Example 1 (CHF) for patient 1 in Spanish -> the server prints the email with the link
#        -> GET /p/:token in English and Spanish (Spanish was produced at ingest, so it comes from the
#        document store) -> GET /translate zh on demand (agent once, cache after) -> expiresAt is 30 days
#        out -> the sweeper runs with DEMO_NOW 31 days ahead against the same stores -> 410 -> the
#        deletion receipts and the link's audit trail.
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

step "1. Health: clock, configuration source, providers"
curl -sS "$BASE_URL/health" | json providers
echo "config source: $(curl -sS "$BASE_URL/health" | json config.source)"

step "2. Pick a patient (GET /patients, provider key)"
PATIENTS=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/patients")
PATIENT_ID="${PATIENT_ID:-$(printf '%s' "$PATIENTS" | json patients.0.id)}"
printf '%s' "$PATIENTS" | json patients.0
echo "patientId=$PATIENT_ID"

step "3. Ingest Example 1, the CHF discharge summary, in $LANGUAGE (POST /ingest -> 202 'ingestion started')"
if [ "${INPUT##*.}" = "pdf" ]; then
  ACCEPTED=$(curl -sS -H "x-provider-key: $KEY" -F "patientId=$PATIENT_ID" -F "language=$LANGUAGE" -F "file=@$INPUT;type=application/pdf" "$BASE_URL/ingest")
else
  ACCEPTED=$(curl -sS -H "x-provider-key: $KEY" -F "patientId=$PATIENT_ID" -F "language=$LANGUAGE" -F "text=<$INPUT" "$BASE_URL/ingest")
fi
echo "$ACCEPTED"
JOB_ID=$(printf '%s' "$ACCEPTED" | json jobId)
LINK_ID=$(printf '%s' "$ACCEPTED" | json linkId)
EXPIRES_AT=$(printf '%s' "$ACCEPTED" | json expiresAt)
[ -n "$JOB_ID" ] && [ "$JOB_ID" != "undefined" ] || { echo "ingest failed"; exit 1; }

step "4. Follow the job (GET /jobs/:id) until done; the server terminal prints the patient email with the link"
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

step "5. The patient opens the link (GET /p/:token): the fixed JSON in English, expiry upfront"
VIEW=$(curl -sS "$BASE_URL/p/$LINK_ID")
echo "steps:"; echo "$VIEW" | json steps
echo "medications (name, dose, status):"
printf '%s' "$VIEW" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).medications)console.log("  ",m.status.padEnd(8),m.name,m.dose)})'
echo "daysLeft=$(echo "$VIEW" | json daysLeft) expiresAt=$(echo "$VIEW" | json expiresAt) availableLanguages=$(echo "$VIEW" | json availableLanguages)"

step "6. Same link in $LANGUAGE (GET /p/:token?language=es): produced at ingest, served from the document store"
ES=$(curl -sS "$BASE_URL/p/$LINK_ID?language=es")
echo "$ES" | json steps.0
echo "fromCache=$(echo "$ES" | json fromCache) language=$(echo "$ES" | json language)"

step "7. Mandarin on demand (GET /translate?language=zh): the translation agent runs once, then the cache answers"
ZH1=$(curl -sS "$BASE_URL/translate?link=$LINK_ID&language=zh")
echo "$ZH1" | json steps.0
echo "first call fromCache=$(echo "$ZH1" | json fromCache)"
ZH2=$(curl -sS "$BASE_URL/translate?link=$LINK_ID&language=Mandarin")
echo "second call fromCache=$(echo "$ZH2" | json fromCache) availableLanguages=$(echo "$ZH2" | json availableLanguages)"
echo "medication names and doses stay verbatim:"; printf '%s' "$ZH2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const m of JSON.parse(s).medications.slice(0,4))console.log("  ",m.name,m.dose,"|",m.howOften)})'

step "8. Lane 3 directly (POST /synthesize { text, language: ar }): the JSON per language plus the safety result, nothing stored"
SYN=$(curl -sS -H "x-provider-key: $KEY" -H 'content-type: application/json' -d "$(node -e 'const fs=require("fs");console.log(JSON.stringify({text:fs.readFileSync(process.argv[1],"utf8"),language:"ar"}))' "$INPUT")" "$BASE_URL/synthesize")
echo "languages=$(echo "$SYN" | json languages) verified=$(echo "$SYN" | json verified) stored=$(echo "$SYN" | json stored)"
echo "$SYN" | json perLanguage.ar.steps.0

step "9. Day 30: the sweeper runs with DEMO_NOW 31 days ahead against the same stores (keys destroyed, items and audio deleted, receipts written)"
DEMO_NOW=$(node -e 'console.log(new Date(Date.now()+31*864e5).toISOString())')
echo "DEMO_NOW=$DEMO_NOW (the link expires at $EXPIRES_AT)"
DEMO_NOW="$DEMO_NOW" npx tsx scripts/sweep.ts

step "10. The link is gone: GET /p/:token and GET /translate answer 410"
curl -sS "$BASE_URL/p/$LINK_ID"; echo " (HTTP $(status "$BASE_URL/p/$LINK_ID"))"
echo "HTTP $(status "$BASE_URL/translate?link=$LINK_ID&language=es") for /translate"

step "11. Deletion receipts and the link's audit trail (no PHI anywhere in them)"
npx tsx scripts/show-audit.ts --receipts
npx tsx scripts/show-audit.ts --link "$LINK_ID"
echo
echo "demo complete"
