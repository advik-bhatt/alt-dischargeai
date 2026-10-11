import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { TranscribeClient, StartMedicalScribeJobCommand, GetMedicalScribeJobCommand, DeleteMedicalScribeJobCommand } from "@aws-sdk/client-transcribe";
import type { SpeechToText, SpeechToTextInput } from "../types.js";
import { mediaFormatFor } from "./medical.js";

export class HealthScribeSpeechToText implements SpeechToText {
  readonly name = "healthscribe";
  private readonly s3: S3Client;
  private readonly tx: TranscribeClient;
  constructor(private readonly opts: { region: string; bucket: string; roleArn: string; timeoutMs?: number; pollIntervalMs?: number; s3?: S3Client; transcribe?: TranscribeClient }) {
    this.s3 = opts.s3 ?? new S3Client({ region: opts.region });
    this.tx = opts.transcribe ?? new TranscribeClient({ region: opts.region, maxAttempts: 1 });
  }
  async transcribe(input: SpeechToTextInput) {
    const started = Date.now(); const jobName = `dischargeai-${randomUUID()}`;
    const format = mediaFormatFor(input.mimeType, input.fileName);
    if (!format) throw new Error("Unsupported HealthScribe audio format");
    const inputKey = `healthscribe/input/${jobName}.${format}`;
    const cleanup = new Set<string>([inputKey, ".write_access_check_file.temp"]);
    let submitted = false;
    try {
      // Always upload here: local audio storage is deliberately separate from S3 staging.
      await this.s3.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: inputKey, Body: input.audio, ContentType: input.mimeType, ServerSideEncryption: "AES256" }));
      await this.tx.send(new StartMedicalScribeJobCommand({
        MedicalScribeJobName: jobName, Media: { MediaFileUri: `s3://${this.opts.bucket}/${inputKey}` },
        OutputBucketName: this.opts.bucket, DataAccessRoleArn: this.opts.roleArn,
        Settings: { ShowSpeakerLabels: true, MaxSpeakerLabels: 2 },
      }));
      submitted = true;
      const deadline = Date.now() + (this.opts.timeoutMs ?? 900_000);
      for (;;) {
        const { MedicalScribeJob: job } = await this.tx.send(new GetMedicalScribeJobCommand({ MedicalScribeJobName: jobName }));
        if (job?.MedicalScribeJobStatus === "FAILED") throw new Error(`HealthScribe job failed: ${job.FailureReason ?? "unknown"}`);
        if (job?.MedicalScribeJobStatus === "COMPLETED") {
          const location = job.MedicalScribeOutput?.TranscriptFileUri;
          if (!location) throw new Error("HealthScribe returned no transcript location");
          const outputKey = this.key(location, jobName); cleanup.add(outputKey);
          if (job.MedicalScribeOutput?.ClinicalDocumentUri) cleanup.add(this.key(job.MedicalScribeOutput.ClinicalDocumentUri, jobName));
          const output = await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: outputKey }));
          const data = JSON.parse(await output.Body!.transformToString()) as { Conversation?: { TranscriptSegments?: { Content?: string; ParticipantDetails?: { ParticipantRole?: string } }[] } };
          const transcript = (data.Conversation?.TranscriptSegments ?? []).map(segment =>
            segment.Content?.trim() ? `${segment.ParticipantDetails?.ParticipantRole ?? "SPEAKER"}: ${segment.Content.trim()}` : "").filter(Boolean).join("\n");
          if (!transcript) throw new Error("HealthScribe returned an empty transcript");
          return { transcript, provider: this.name, jobName, latencyMs: Date.now() - started };
        }
        if (Date.now() >= deadline) throw new Error("HealthScribe timed out");
        await new Promise(resolve => setTimeout(resolve, this.opts.pollIntervalMs ?? 5000));
      }
    } finally {
      // S3 lifecycle is the backstop if cleanup permissions or a timed-out job prevent deletion.
      await Promise.allSettled([...cleanup].map(Key => this.s3.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key }))));
      if (submitted) await this.tx.send(new DeleteMedicalScribeJobCommand({ MedicalScribeJobName: jobName })).catch(() => {});
    }
  }
  private key(uri: string, jobName: string) {
    const location = new URL(uri);
    const pathStyle = location.protocol === "https:" && /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(location.hostname);
    const parts = location.pathname.slice(1).split("/");
    const bucket = location.protocol === "s3:" ? location.hostname : pathStyle ? parts.shift() : location.hostname.split(".s3")[0];
    const key = decodeURIComponent(parts.join("/"));
    if (!["s3:", "https:"].includes(location.protocol)) throw new Error("Unexpected HealthScribe output protocol");
    if (bucket !== this.opts.bucket || !key.startsWith(`${jobName}/`)) throw new Error("Unexpected HealthScribe output location");
    return key;
  }
}
