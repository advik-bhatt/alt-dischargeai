import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { loadTranscriptFixture } from "./offline/fixtures.js";
import type { SpeechToText, SpeechToTextInput, SpeechToTextResult } from "./types.js";

export type { SpeechToText, SpeechToTextInput, SpeechToTextResult } from "./types.js";

/** Offline twin: returns the synthetic CHF dictation for any non-empty audio clip. */
export class OfflineSpeechToText implements SpeechToText {
  readonly name = "offline";

  async transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult> {
    const t0 = Date.now();
    if (!input.audio || input.audio.length === 0) throw new Error("empty audio");
    return { transcript: loadTranscriptFixture("dictation-1"), provider: this.name, latencyMs: Date.now() - t0 };
  }
}

/** SPEECH_PROVIDER=transcribe -> Amazon Transcribe Medical over the S3 audio bucket; anything else -> offline fixture. */
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
