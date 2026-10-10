import type { TranscribeInput, TranscribeResult, TranscriberAgent } from "../transcriber.js";
import { loadTranscriptFixture } from "./fixtures.js";

/** Returns the synthetic CHF dictation for any audio upload so the dictate button works with no AWS account. */
export class OfflineTranscriber implements TranscriberAgent {
  readonly name = "offline";

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const t0 = Date.now();
    if (!input.audio || input.audio.length === 0) throw new Error("empty audio");
    return { text: loadTranscriptFixture("dictation-1"), provider: this.name, latencyMs: Date.now() - t0 };
  }
}
