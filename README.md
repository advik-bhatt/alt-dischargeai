# DischargeAI

Patients leave the hospital with discharge instructions written for clinicians. DischargeAI turns a discharge summary (pasted text, a PDF, or dictated audio) into a plain-language Going-Home Plan, sends the patient and their caregiver a private link to it, and deletes everything 30 days later.

- An AI agent on Amazon Bedrock AgentCore writes the plan from the clinician's own instructions and reviews it, flagging anything a clinician should check.
- The patient link is an unguessable 256-bit id; the patient or caregiver also confirms the patient's date of birth.
- Every record, file and link expires at day 30, enforced at read time and by automatic deletion, with a deletion receipt that holds no patient data.
- For those 30 days the patient or caregiver checks in daily from the plan page: medicines taken, any of the plan's own warning signs, weight, and one teach-back question about when a medicine is taken. Plain rules in code (not a model) flag a get-help-now sign as urgent, and missed medicines, a call-your-doctor sign, weight up 2 lb since the last check-in or 5 lb in a week, a wrong teach-back answer, or two days without a check-in as needing attention. The doctor's dashboard shows every live plan's follow-up, flagged ones first. Check-ins are stored on the plan and deleted with it.

The repository holds the web app (`frontend/`), the server (`backend/`), and the agent, translator and patient chatbot source (`AI-Infra/`). The server serves the built app and its API (under `/api`) from one origin. Signed-out visitors land on the product landing page at `/` (`frontend/src/Landing.tsx`); `/login` and patient links (`/s/<id>`, `/p/<id>`) go to sign-in. Patients and caregivers can ask questions about their plan from the plan page ("Ask about your plan"). In hosted mode an anonymous `GET /api/health` returns only the mode and capabilities; the providers, AWS runtime and database details need the `x-provider-key` header.

## Run it

Node 24. From the repository root:

```sh
npm run install:all
npm run build
npm run local
```

Open `http://127.0.0.1:4000` and sign in as the doctor `rivera@demo.health` / `demo1234`. This runner uses in-memory storage and labeled AI and speech fixtures, needs no AWS, and forgets everything when it stops.

`npm run local:ai` runs the same app against the live AgentCore agent, dictation, translation and read-aloud, with data kept in `.local-data/`. It reads AWS credentials and `AGENT_RUNTIME_ARN` from the ignored `backend/.env` (copy `backend/.env.example`).

`npm test` runs the unit and API tests. [docs/testing.md](docs/testing.md) has the full walkthroughs (registration, the 30-day append rule, live browser checks, the practice PDF, Swagger), and [backend/README.md](backend/README.md) covers the server, its API and the AWS-only mode.

## Hosted deployment (Vercel)

The hosted app is the `local:ai` app with its SQLite file swapped for Postgres, so it runs on a server that keeps nothing on disk. `Dockerfile.vercel` builds the frontend, installs the backend and the AI-Infra Python translator, and runs `backend/src/hosted/server.ts` on Vercel's container runtime (beta). Pushing to `main` deploys it. One origin serves the UI and `/api`.

Storage is the Supabase project `dischargeai`, schema `dischargeai` (not `public`, so Supabase's auto-generated Data API cannot reach it), logged in as the role `dischargeai_app`. On boot the server creates its tables when missing (`backend/src/hosted/postgres.ts`: `activeLinks`, `jobs`, `audit_log`, `patientinfo`, plus `hosted_summaries` for plans and `hosted_objects` for uploaded PDFs and audio) and adds the two synthetic demo patients (IDs 7 and 8, DOB `2000-01-01`) that the login screen's patient and caregiver codes use.

Environment variables (Vercel project settings):

| Variable | Needed for | Notes |
| --- | --- | --- |
| `POSTGRES_URL` | boot | `postgres://dischargeai_app.<project-ref>:<password>@<pooler-host>:5432/postgres` |
| `PROVIDER_API_KEY` | boot | long random value; the server refuses to start with `dev-provider-key` |
| `DOCTOR_EMAIL`, `DOCTOR_PASSWORD` | doctor sign-in | the one provider account; set to the demo account the login screen shows |
| `PATIENT_APP_URL` | patient links | the deployment's public URL; defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL` |
| `AGENT_RUNTIME_ARN` | plan generation | an AgentCore runtime the AWS credentials may invoke; the region comes from the ARN |
| `DISCHARGEAI_AWS_ACCESS_KEY_ID`, `DISCHARGEAI_AWS_SECRET_ACCESS_KEY`, `DISCHARGEAI_AWS_SESSION_TOKEN` | plan generation, dictation, translation | Vercel does not pass the standard `AWS_*` key names to the container, so the server copies these into them at boot. Temporary hackathon credentials expire and must be replaced when they do; `AWS_REGION` is set as usual |
| `TRANSLATION_PROVIDER` | translation | `ai-infra` runs the AI-Infra translator (Python is in the image); it needs the AWS credentials too |
| `CHAT_PROVIDER` | the patient chat | `ai-infra` runs the AI-Infra patient chatbot (answers only from the patient's plan); it needs the AWS credentials too |
| `ELEVENLABS_API_KEY` | read-aloud | optional |

Without `AGENT_RUNTIME_ARN` and working AWS credentials the app still signs in, registers patients and accepts writeups, and each job fails with "AI is not configured on this server"; there is no fixture fallback. Emails print to the server log (`EMAIL_TRANSPORT=console`). Jobs run inside the instance that accepted them; a job whose instance was stopped is picked up again by the next instance once it has been idle longer than `AGENT_TIMEOUT_MS` plus a minute. `npm test` covers the hosted mode against a real Postgres when `HOSTED_TEST_POSTGRES_URL` is set (see `backend/test/hosted.test.ts`).

To run the same image locally: `docker build -f Dockerfile.vercel -t dischargeai-hosted .` then `docker run -p 8080:80 -e POSTGRES_URL=... -e PROVIDER_API_KEY=... -e DOCTOR_EMAIL=... -e DOCTOR_PASSWORD=... dischargeai-hosted`.
