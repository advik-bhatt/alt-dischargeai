import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SpeechToText } from "./types.js";

export type { SpeechToText, SpeechToTextInput, SpeechToTextResult } from "./types.js";

/** Amazon Transcribe Medical over the S3 audio bucket. */
export async function createSpeechToText(config: Config, log: Logger): Promise<SpeechToText> {
  if (config.SPEECH_PROVIDER === "healthscribe") {
    if (!config.HEALTHSCRIBE_BUCKET || !config.HEALTHSCRIBE_ROLE_ARN) throw new Error("HealthScribe requires HEALTHSCRIBE_BUCKET and HEALTHSCRIBE_ROLE_ARN");
    const { HealthScribeSpeechToText } = await import("./transcribe/healthscribe.js");
    return new HealthScribeSpeechToText({ region: config.HEALTHSCRIBE_REGION, bucket: config.HEALTHSCRIBE_BUCKET, roleArn: config.HEALTHSCRIBE_ROLE_ARN, timeoutMs: config.HEALTHSCRIBE_TIMEOUT_MS });
  }
  const { TranscribeMedicalSpeechToText } = await import("./transcribe/medical.js");
  return new TranscribeMedicalSpeechToText({
    region: config.AWS_REGION,
    audioBucket: config.AUDIO_BUCKET,
    outputBucket: config.TRANSCRIBE_OUTPUT_BUCKET ?? config.AUDIO_BUCKET,
    log,
  });
}
