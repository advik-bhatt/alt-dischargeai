import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Simplifier, SimplifyResult } from "./types.js";

export type { Simplifier, SimplifyResult } from "./types.js";

/** LLM_PROVIDER=bedrock (Claude on Amazon Bedrock, Converse API) | anthropic (the direct Anthropic API). */
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
    default:
      throw new Error(`Unknown LLM_PROVIDER "${config.LLM_PROVIDER}"`);
  }
}
