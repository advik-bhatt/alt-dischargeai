import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { SpeechToText, SpeechToTextInput, SpeechToTextResult } from "./types.js";

export type { SpeechToText, SpeechToTextInput, SpeechToTextResult } from "./types.js";

/** Offline placeholder: there is no offline transcript, so a dictated clip needs SPEECH_PROVIDER=transcribe. */
export class OfflineSpeechToText implements SpeechToText {
  readonly name = "offline";

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    if (!input.audio || input.audio.length === 0) throw new Error("empty audio");
    throw new Error("No speech-to-text is configured: set SPEECH_PROVIDER=transcribe (Amazon Transcribe Medical) to ingest dictated audio");
  }
}

/** SPEECH_PROVIDER=transcribe -> Amazon Transcribe Medical over the S3 audio bucket; anything else -> the offline placeholder, which cannot transcribe. */
export async function createSpeechToText(config: Config, log: Logger): Promise<SpeechToText> {
  if (config.SPEECH_PROVIDER === "transcribe") {
    const { TranscribeMedicalSpeechToText } = await import("./transcribe/medical.js");
    return new TranscribeMedicalSpeechToText({
      region: config.AWS_REGION,
      audioBucket: config.AUDIO_BUCKET,
      outputBucket: config.TRANSCRIBE_OUTPUT_BUCKET ?? config.AUDIO_BUCKET,
      log,
    });
  }
  return new OfflineSpeechToText();
}
