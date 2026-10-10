#!/bin/sh
# DischargeAI demo narrative against a running backend (default: offline providers, no keys needed).
#   npm run dev            (in another terminal)
#   npm run demo           (this script)
# Steps: ingest Example 1 (CHF) -> email printed by the server -> GET /summary -> GET /translate?language=Spanish
#        -> advance the clock 30 days -> 410 -> purge -> audit trail.
# Needs curl and node (for JSON parsing). Override BASE_URL / PROVIDER_API_KEY / PATIENT_ID / INPUT as needed.
set -eu

BASE_URL="${BASE_URL:-http://localhost:${PORT:-4000}}"
KEY="${PROVIDER_API_KEY:-dev-provider-key}"
INPUT="${INPUT:-fixtures/discharge-summaries/example-1-chf.txt}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(typeof v==="string"?v:JSON.stringify(v))})' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "1. Health"
curl -sS "$BASE_URL/health"; echo

step "2. Pick a patient (GET /patients)"
PATIENTS=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/patients")
PATIENT_ID="${PATIENT_ID:-$(printf '%s' "$PATIENTS" | json patients.0.id)}"
printf '%s' "$PATIENTS" | json patients.0
echo "patientId=$PATIENT_ID"

step "3. Ingest Example 1, the CHF discharge summary (POST /ingest -> 202)"
if [ "${INPUT##*.}" = "pdf" ]; then
  ACCEPTED=$(curl -sS -H "x-provider-key: $KEY" -F "patientId=$PATIENT_ID" -F "file=@$INPUT;type=application/pdf" "$BASE_URL/ingest")
else
  ACCEPTED=$(curl -sS -H "x-provider-key: $KEY" -F "patientId=$PATIENT_ID" -F "text=<$INPUT" "$BASE_URL/ingest")
fi
echo "$ACCEPTED"
JOB_ID=$(printf '%s' "$ACCEPTED" | json jobId)
LINK_ID=$(printf '%s' "$ACCEPTED" | json linkId)
[ -n "$JOB_ID" ] && [ "$JOB_ID" != "undefined" ] || { echo "ingest failed"; exit 1; }

step "4. Poll the job (GET /jobs/:id) until done; the server prints the patient email"
for i in $(seq 1 120); do
  JOB=$(curl -sS -H "x-provider-key: $KEY" "$BASE_URL/jobs/$JOB_ID")
  STAGE=$(printf '%s' "$JOB" | json stage)
  echo "  stage=$STAGE"
  case "$STAGE" in done|needs_review|failed) break ;; esac
  sleep 1
done
echo "$JOB"
[ "$STAGE" != "failed" ] || { echo "job failed"; exit 1; }

step "5. The patient opens the link (GET /summary?link=...)"
SUMMARY=$(curl -sS "$BASE_URL/summary?link=$LINK_ID")
echo "$SUMMARY" | json summary
echo "new medications:"; echo "$SUMMARY" | json medications.new
echo "daysLeft:"; echo "$SUMMARY" | json daysLeft
echo "verification:"; echo "$SUMMARY" | json verification

step "6. One tap: Spanish (GET /translate?language=Spanish)"
TR=$(curl -sS "$BASE_URL/translate?link=$LINK_ID&language=Spanish")
echo "$TR" | json summary
echo "fromCache:"; echo "$TR" | json fromCache
TR2=$(curl -sS "$BASE_URL/translate?link=$LINK_ID&language=es")
echo "second call fromCache:"; echo "$TR2" | json fromCache

step "7. The patient ticks a checklist item (POST /checklist/complete)"
FIRST_ITEM=$(echo "$SUMMARY" | json checklist.0.id)
curl -sS -H 'content-type: application/json' -d "{\"link\":\"$LINK_ID\",\"itemId\":\"$FIRST_ITEM\",\"completed\":true}" "$BASE_URL/checklist/complete"; echo

step "8. Day 30 arrives (POST /admin/clock/advance 30 days) -> GET /summary is 410"
curl -sS -H "x-provider-key: $KEY" -H 'content-type: application/json' -d '{"days":30}' "$BASE_URL/admin/clock/advance"; echo
curl -sS -o /dev/stderr -w 'HTTP %{http_code}\n' "$BASE_URL/summary?link=$LINK_ID"

step "9. Purge runs (POST /admin/purge): key destroyed, documents deleted, link purged"
curl -sS -H "x-provider-key: $KEY" -X POST "$BASE_URL/admin/purge"; echo
curl -sS -o /dev/stderr -w 'HTTP %{http_code}\n' "$BASE_URL/summary?link=$LINK_ID"

step "10. Audit trail (GET /audit?link=...), no PHI"
curl -sS -H "x-provider-key: $KEY" "$BASE_URL/audit?link=$LINK_ID" | json events | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(" ",e.at,e.actor.padEnd(8),e.event.padEnd(20),JSON.stringify(e.details))})'

step "11. Reset the demo clock"
curl -sS -H "x-provider-key: $KEY" -X POST "$BASE_URL/admin/clock/reset"; echo
echo "demo complete"
