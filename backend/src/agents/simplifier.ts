import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { LlmUsage, SimplifiedSummary } from "./types.js";

export interface SimplifyInput {
  /** The clinician's discharge text, already extracted from PDF or transcribed from audio. */
  text: string;
  /** Patient's preferred language, informational only; the simplifier always writes English. */
  language?: string;
}

export interface SimplifyResult {
  summary: SimplifiedSummary;
  provider: string;
  model?: string;
  usage?: LlmUsage;
  latencyMs?: number;
  /** Which fixture matched, for the offline provider. */
  fixture?: string;
}

/**
 * Team integration contract. A teammate replaces the simplifier by implementing this interface in one
 * file (for example src/agents/custom/simplifier.ts), registering it in createSimplifier below under a
 * new LLM_PROVIDER value, and setting that env var. The backend validates the result with zod and
 * runs the deterministic fidelity check on it either way.
 */
export interface SimplifierAgent {
  readonly name: string;
  simplify(input: SimplifyInput): Promise<SimplifyResult>;
}

export async function createSimplifier(config: Config, log: Logger): Promise<SimplifierAgent> {
  switch (config.LLM_PROVIDER) {
    case "bedrock": {
      const { BedrockSimplifier } = await import("./bedrock/simplifier.js");
      return new BedrockSimplifier({ modelId: config.BEDROCK_MODEL_ID, region: config.AWS_REGION, log });
    }
    case "anthropic": {
      const { AnthropicSimplifier } = await import("./anthropic/simplifier.js");
      return new AnthropicSimplifier({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, log });
    }
    case "offline":
    default: {
      const { OfflineSimplifier } = await import("./offline/simplifier.js");
      return new OfflineSimplifier();
    }
  }
}
