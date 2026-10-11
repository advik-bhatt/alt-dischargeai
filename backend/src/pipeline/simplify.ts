import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { ruleBasedSimplify } from "./offline/rules.js";
import type { Simplifier, SimplifyResult } from "./types.js";

export type { Simplifier, SimplifyResult } from "./types.js";

/**
 * Offline twin of "Jargon to plain language": rule-based extraction, no model and no keys. It reads
 * discharge text laid out with headings and bulleted lines; anything else is caught by the safety
 * check and held for review.
 */
export class OfflineSimplifier implements Simplifier {
  readonly name = "offline";

  async simplify(input: { text: string }): Promise<SimplifyResult> {
    const t0 = Date.now();
    return { output: ruleBasedSimplify(input.text), provider: this.name, model: "rules", latencyMs: Date.now() - t0 };
  }
}

/** LLM_PROVIDER=bedrock (Claude on Amazon Bedrock, Converse API) | anthropic | offline. */
export async function createSimplifier(config: Config, log: Logger): Promise<Simplifier> {
  switch (config.LLM_PROVIDER) {
    case "bedrock": {
      const { BedrockSimplifier } = await import("./bedrock/simplify.js");
      return new BedrockSimplifier({ modelId: config.BEDROCK_MODEL_ID, region: config.AWS_REGION, log });
    }
    case "anthropic": {
      const { AnthropicSimplifier } = await import("./anthropic/simplify.js");
      return new AnthropicSimplifier({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL, log });
    }
    case "offline":
    default:
      return new OfflineSimplifier();
  }
}
