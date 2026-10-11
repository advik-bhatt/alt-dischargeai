# HealthScribe configuration

The current local integration uses account `958824257887`, HealthScribe region `us-east-1`, private staging bucket `dischargeai-healthscribe-958824257887-us-east-1`, and service role `DischargeAIHealthScribeEast1`. AgentCore and AI-Infra translation stay in `us-west-2`. These resources were created for this integration; team resources were not changed.

The bucket blocks public access, uses S3-managed AES256 encryption, and expires objects after 30 days. The backend deletes input audio, transcript, clinical-document output, and the AWS write-check file after processing, then deletes HealthScribe job metadata. Failed cleanup or timed-out jobs rely on the lifecycle backstop. Application audio/PDF bytes and plan data remain in local SQLite.

The service role trusts `transcribe.amazonaws.com` only with source account `958824257887` and source ARN `arn:aws:transcribe:us-east-1:958824257887:*`, following [AWS's documented trust policy](https://docs.aws.amazon.com/transcribe/latest/dg/security_iam_id-based-policy-examples.html). The user explicitly approved that account/region trust scope. The inline S3 policy permits:

- `s3:GetObject` on this bucket's `healthscribe/input/*` prefix.
- `s3:PutObject` on this bucket's `dischargeai-*/*` outputs and exact `.write_access_check_file.temp` key.
- `s3:ListBucket` and `s3:GetBucketLocation` on this bucket alone.

The calling AWS identity needs `iam:PassRole` for that role, Start/Get/DeleteMedicalScribeJob, and upload/read/delete permissions for the same staging objects. Do not attach administrative IAM permissions to the service role. Its S3 policy was refined from the IAM Policy Autopilot result generated from the HealthScribe adapter source.

Configure the ignored `backend/.env`:

```dotenv
AWS_REGION=us-west-2
SPEECH_PROVIDER=healthscribe
HEALTHSCRIBE_REGION=us-east-1
HEALTHSCRIBE_BUCKET=dischargeai-healthscribe-958824257887-us-east-1
HEALTHSCRIBE_ROLE_ARN=arn:aws:iam::958824257887:role/DischargeAIHealthScribeEast1
HEALTHSCRIBE_TIMEOUT_MS=900000
TRANSLATION_PROVIDER=ai-infra
PYTHON_EXECUTABLE=../AI-Infra/.venv/Scripts/python.exe
ELEVENLABS_API_KEY=<your server-side text-to-speech key>
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
```

Use an absolute Python path if your working directory differs. Install `AI-Infra/requirements.txt` in that environment. Supply temporary AWS credentials through the normal credential chain or the ignored `.env`; renew them when expired. Restart `npm run local:ai` after changing keys. Never use `VITE_*` variables for provider secrets.

The microphone records English clinician audio. The existing translation agent supplies Spanish, Chinese and Arabic patient text; ElevenLabs reads the selected translated plan. `/api/health` capability flags show configured providers, not a live health guarantee. `npm run test:features` performs real browser/provider checks with synthetic audio.
