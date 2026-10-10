import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  GetMedicalTranscriptionJobCommand,
  StartMedicalTranscriptionJobCommand,
  TranscribeClient,
  type MediaFormat,
} from "@aws-sdk/client-transcribe";
import type { Logger } from "../../logger.js";
import type { TranscribeInput, TranscribeResult, TranscriberAgent } from "../transcriber.js";

/**
 * Amazon Transcribe Medical, batch dictation. Needs an S3 bucket the service can read from and write
 * to: PutObject the audio -> StartMedicalTranscriptionJob (LanguageCode en-US, Specialty PRIMARYCARE,
 * Type DICTATION) -> poll GetMedicalTranscriptionJob -> GetObject the transcript JSON ->
 * results.transcripts[0].transcript. Shapes from the API reference in docs/research.md 4.5.
 * IAM: transcribe:StartMedicalTranscriptionJob, transcribe:GetMedicalTranscriptionJob, s3:PutObject,
 * s3:GetObject, and Transcribe needs write access to the output bucket.
 */
export interface AwsTranscriberOptions {
  region: string;
  inputBucket?: string;
  outputBucket?: string;
  log?: Logger;
  pollIntervalMs?: number;
  timeoutMs?: number;
  s3?: S3Client;
  transcribe?: TranscribeClient;
}

const FORMAT_BY_MIME: Record<string, MediaFormat> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/amr": "amr",
};

export function mediaFormatFor(mimeType: string, fileName?: string): MediaFormat | undefined {
  const byMime = FORMAT_BY_MIME[mimeType.toLowerCase().split(";")[0]];
  if (byMime) return byMime;
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext && ["mp3", "mp4", "wav", "flac", "ogg", "amr", "webm", "m4a"].includes(ext)) return ext as MediaFormat;
  return undefined;
}

export class AwsMedicalTranscriber implements TranscriberAgent {
  readonly name = "aws";
  private readonly s3: S3Client;
  private readonly tx: TranscribeClient;

  constructor(private readonly opts: AwsTranscriberOptions) {
    this.s3 = opts.s3 ?? new S3Client({ region: opts.region });
    this.tx = opts.transcribe ?? new TranscribeClient({ region: opts.region });
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const inputBucket = this.opts.inputBucket;
    const outputBucket = this.opts.outputBucket ?? inputBucket;
    if (!inputBucket || !outputBucket) {
      throw new Error("TRANSCRIBE_PROVIDER=aws needs TRANSCRIBE_BUCKET (and optionally TRANSCRIBE_OUTPUT_BUCKET)");
    }
    const t0 = Date.now();
    const jobName = `dischargeai-${randomUUID()}`;
    const format = mediaFormatFor(input.mimeType, input.fileName);
    const key = `audio/${jobName}.${format ?? "bin"}`;

    await this.s3.send(
      new PutObjectCommand({ Bucket: inputBucket, Key: key, Body: input.audio, ContentType: input.mimeType }),
    );
    await this.tx.send(
      new StartMedicalTranscriptionJobCommand({
        MedicalTranscriptionJobName: jobName,
        LanguageCode: "en-US",
        Specialty: "PRIMARYCARE",
        Type: "DICTATION",
        Media: { MediaFileUri: `s3://${inputBucket}/${key}` },
        ...(format ? { MediaFormat: format } : {}),
        OutputBucketName: outputBucket,
        OutputKey: `transcripts/${jobName}.json`,
      }),
    );

    const deadline = Date.now() + (this.opts.timeoutMs ?? 10 * 60 * 1000);
    const interval = this.opts.pollIntervalMs ?? 5000;
    for (;;) {
      const { MedicalTranscriptionJob: job } = await this.tx.send(
        new GetMedicalTranscriptionJobCommand({ MedicalTranscriptionJobName: jobName }),
      );
      const status = job?.TranscriptionJobStatus;
      if (status === "COMPLETED") break;
      if (status === "FAILED") throw new Error(`Transcribe Medical job failed: ${job?.FailureReason ?? "unknown"}`);
      if (Date.now() > deadline) throw new Error("Transcribe Medical job timed out");
      await new Promise((r) => setTimeout(r, interval));
    }

    const obj = await this.s3.send(new GetObjectCommand({ Bucket: outputBucket, Key: `transcripts/${jobName}.json` }));
    const body = await obj.Body?.transformToString("utf8");
    if (!body) throw new Error("Transcribe Medical produced an empty transcript object");
    const parsed = JSON.parse(body) as { results?: { transcripts?: { transcript?: string }[] } };
    const text = parsed.results?.transcripts?.[0]?.transcript?.trim() ?? "";
    if (!text) throw new Error("Transcribe Medical transcript was empty");
    this.opts.log?.info({ jobName, ms: Date.now() - t0 }, "transcribe medical job completed");
    return { text, provider: this.name, jobName, latencyMs: Date.now() - t0 };
  }
}
